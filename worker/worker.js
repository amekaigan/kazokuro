/**
 * kazokuro-api — Cloudflare Worker
 *
 * かぞクロ（家族ローゼット）から呼ぶ Claude プロキシ。
 * APIキーはこの Worker の環境変数にだけ置き、ブラウザには一切出さない。
 *
 * 必要な環境変数（Worker の Settings → Variables で設定）
 *   ANTHROPIC_API_KEY  … Anthropic のAPIキー（Secret として登録すること）
 *   ALLOW_ORIGINS      … 許可するオリジンをカンマ区切りで
 *                        例: https://amekaigan.github.io,http://localhost:8080
 *
 * エンドポイント
 *   POST /analyze   写真1枚 → 服の特徴をJSONで返す
 *   POST /identify  コーデ写真1枚 + 手持ちリスト → 該当しそうな服のIDを返す
 *   GET  /health    疎通確認
 */

const MODEL = 'claude-haiku-4-5-20251001';

/* ---------- CORS ---------- */
function allowed(env, origin){
  if(!origin) return null;
  const list=(env.ALLOW_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}
function cors(origin){
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(data, origin, status=200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type':'application/json; charset=utf-8', ...cors(origin) }
  });
}

/* ---------- Claude 呼び出し ---------- */
async function callClaude(env, messages, maxTokens=1024){
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version':'2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages })
  });
  if(!r.ok){
    const text = await r.text();
    throw new Error('claude '+r.status+': '+text.slice(0,300));
  }
  const data = await r.json();
  return (data.content||[])
    .filter(b=>b.type==='text')
    .map(b=>b.text)
    .join('');
}
/* モデルが ```json で包んで返すことがあるので剥がす */
function parseJSON(text){
  const clean = String(text).replace(/```json/gi,'').replace(/```/g,'').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if(s<0||e<0) throw new Error('JSONが見つかりません');
  return JSON.parse(clean.slice(s, e+1));
}

/* ---------- プロンプト ---------- */
const ANALYZE_PROMPT = `あなたは子ども服・家庭衣類の分類の専門家です。
写真に写っている「衣類1点」の特徴を読み取り、JSONだけを返してください。
前置き・説明・マークダウンの記号は一切書かないこと。

{
  "category": "tops|bottoms|outer|dress|shoes|under|pajama|goods|other",
  "color": "ホワイト|ブラック|グレー|ネイビー|ブルー|サックス|グリーン|カーキ|イエロー|オレンジ|レッド|ピンク|パープル|ブラウン|ベージュ|柄物",
  "pattern": "無地|ボーダー|ストライプ|ドット|チェック|花柄|プリント|その他",
  "hasCharacterPrint": true|false,
  "season": ["春","夏","秋","冬"],
  "sleeve": "なし|半袖|七分袖|長袖|該当なし",
  "confidence": 0.0〜1.0
}

判断の指針
- 人が着ている写真でも、その衣類1点だけに注目する。複数写っていれば一番大きく写っているものを選ぶ。
- hasCharacterPrint は、アニメ・漫画・ブランドのキャラクターやロゴが印刷されていれば true。
- パジャマ・ルームウェアは pajama。下着・肌着・靴下は under。
- 自信がないときは confidence を低くする。推測で断定しない。`;

const IDENTIFY_PROMPT = `写真に写っている人が着ている服を読み取り、
候補リストの中から該当しそうなものを選んでJSONだけを返してください。
前置き・説明・マークダウンの記号は一切書かないこと。

{
  "worn": [
    { "id": "候補リストのid", "confidence": 0.0〜1.0, "why": "判断の根拠を20字以内" }
  ],
  "unmatched": ["リストに無さそうな服の説明"]
}

判断の指針
- 確実でなくてよい。色とカテゴリが合うものは候補として挙げる。
- 同じ色・同じ種類が複数あるなら、全部挙げて confidence を下げる。
- 迷ったら worn を空にしてよい。無理に当てない。`;

/* ---------- 本体 ---------- */
export default {
  async fetch(request, env){
    const origin = request.headers.get('Origin');
    const ok = allowed(env, origin);

    if(request.method==='OPTIONS'){
      return ok ? new Response(null,{status:204,headers:cors(ok)})
                : new Response('forbidden',{status:403});
    }
    const url = new URL(request.url);
    if(url.pathname==='/health'){
      return json({ok:true, model:MODEL}, ok||'*');
    }
    if(!ok) return new Response('forbidden origin',{status:403});
    if(request.method!=='POST') return json({error:'POSTのみ'}, ok, 405);

    let body;
    try{ body = await request.json() }
    catch(e){ return json({error:'JSONを読めません'}, ok, 400) }

    const image = body.image;   // dataURL または base64
    if(!image) return json({error:'imageがありません'}, ok, 400);

    // dataURL を media_type と base64 に分ける
    let mediaType='image/jpeg', b64=image;
    const m = /^data:([^;]+);base64,(.*)$/s.exec(image);
    if(m){ mediaType=m[1]; b64=m[2] }
    if(b64.length > 7_000_000) return json({error:'画像が大きすぎます'}, ok, 413);

    const imageBlock = { type:'image', source:{ type:'base64', media_type:mediaType, data:b64 } };

    try{
      if(url.pathname==='/analyze'){
        const text = await callClaude(env, [
          { role:'user', content:[ imageBlock, { type:'text', text: ANALYZE_PROMPT } ] }
        ]);
        return json({ ok:true, result: parseJSON(text) }, ok);
      }

      if(url.pathname==='/identify'){
        const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0,300) : [];
        if(!candidates.length) return json({error:'candidatesがありません'}, ok, 400);
        const list = candidates
          .map(c=>`- id:${c.id} / ${c.category} / ${c.color||'色不明'} / ${c.size||''} / ${c.brand||''}`)
          .join('\n');
        const text = await callClaude(env, [
          { role:'user', content:[
            imageBlock,
            { type:'text', text: IDENTIFY_PROMPT + '\n\n候補リスト:\n' + list }
          ]}
        ], 2048);
        return json({ ok:true, result: parseJSON(text) }, ok);
      }

      return json({error:'不明なパスです'}, ok, 404);

    }catch(err){
      return json({ error: String(err.message||err) }, ok, 502);
    }
  }
};
