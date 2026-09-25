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
 * 回数の制限（Settings → Bindings で D1 データベースを変数名 DB でつなぐと有効になる）
 *   LIMIT_PER_MIN      … 同じ接続元から1分に何回まで（省略時 60）
 *   LIMIT_PER_DAY      … 同じ接続元から1日に何回まで（省略時 400）
 *   LIMIT_GLOBAL_DAY   … 全員あわせて1日に何回まで（省略時 3000）
 *   HASH_SALT          … 接続元を元に戻せない形にするときに混ぜる文字（Secret 推奨・省略可）
 *
 * エンドポイント
 *   POST /analyze   写真1枚 → 服の特徴をJSONで返す
 *   POST /identify  コーデ写真1枚 + 手持ちリスト → 該当しそうな服のIDを返す
 *   GET  /health    疎通確認（limit: true なら回数の制限が効いている）
 *
 * 写真はどこにも保存しない。受け取った写真を Claude に渡し、結果を返すだけ。
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

/* ---------- 回数の制限 ----------
   Origin はブラウザの外からなら偽れるので、それだけでは勝手な利用を止められない。
   接続元（IPアドレス）ごとに回数を数え、多すぎたら断る。
   IPアドレスはそのまま残さず、日ごとに変わる文字を混ぜて元に戻せない形にしてから数え、2日で消す。
   D1 がつながっていないとき・数えるのに失敗したときは、止めずに通す（利用者を困らせないほう） */
function limitsOf(env){
  const n=(v,d)=>{ const x=parseInt(v,10); return x>0?x:d };
  return { perMin:n(env.LIMIT_PER_MIN,60), perDay:n(env.LIMIT_PER_DAY,400), globalDay:n(env.LIMIT_GLOBAL_DAY,3000) };
}
async function hashIP(ip, day, salt){
  const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt+'|'+day+'|'+ip));
  return [...new Uint8Array(buf)].slice(0,12).map(b=>b.toString(16).padStart(2,'0')).join('');
}
let tableReady=false;
const UPSERT='INSERT INTO hits (k,n,exp) VALUES (?1,1,?2) ON CONFLICT(k) DO UPDATE SET n=n+1 RETURNING n';
async function checkLimit(env, request, ctx){
  if(!env.DB) return null;
  try{
    if(!tableReady){
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)').run();
      tableReady=true;
    }
    const now=Date.now();
    const day=new Date(now+9*3600_000).toISOString().slice(0,10);   // 日本時間の日付
    const h=await hashIP(request.headers.get('CF-Connecting-IP')||'unknown', day, env.HASH_SALT||'kazokuro');
    const keep=now+2*86400_000;
    const L=limitsOf(env);
    const n=r=>r?.results?.[0]?.n||0;
    const [m,d]=await env.DB.batch([
      env.DB.prepare(UPSERT).bind('m:'+h+':'+Math.floor(now/60000), now+120_000),
      env.DB.prepare(UPSERT).bind('d:'+h, keep),
    ]);
    if(Math.random()<0.02){   // ときどき古い記録を消す
      const del=env.DB.prepare('DELETE FROM hits WHERE exp < ?1').bind(now).run().catch(()=>{});
      ctx?.waitUntil ? ctx.waitUntil(del) : await del;
    }
    if(n(d)>L.perDay) return '今日はAIをたくさん使いました。明日もう一度お試しください';
    if(n(m)>L.perMin) return '続けて使われています。1分ほど待ってからもう一度お試しください';
    // 全員あわせた回数は、上で断られなかったときだけ数える（1人が連打して全員を止められないように）
    const g=await env.DB.prepare(UPSERT).bind('g:'+day, keep).all();
    if(n(g)>L.globalDay) return 'ただいまAIの利用が集中しています。明日もう一度お試しください';
    return null;
  }catch(e){
    console.error('limit', e);
    return null;
  }
}

/* 候補リストの文字は、AIへの指示に紛れ込まないよう1行・短めにそろえる */
const clip=(v,n=80)=>String(v??'').replace(/[\r\n]+/g,' ').slice(0,n);
const IMAGE_TYPES=['image/jpeg','image/png','image/webp','image/gif'];

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
  async fetch(request, env, ctx){
    const origin = request.headers.get('Origin');
    const ok = allowed(env, origin);

    if(request.method==='OPTIONS'){
      return ok ? new Response(null,{status:204,headers:cors(ok)})
                : new Response('forbidden',{status:403});
    }
    const url = new URL(request.url);
    if(url.pathname==='/health'){
      return json({ok:true, model:MODEL, limit:!!env.DB}, ok||'*');
    }
    if(!ok) return new Response('forbidden origin',{status:403});
    if(request.method!=='POST') return json({error:'POSTのみ'}, ok, 405);
    if(url.pathname!=='/analyze' && url.pathname!=='/identify') return json({error:'不明なパスです'}, ok, 404);

    let body;
    try{ body = await request.json() }
    catch(e){ return json({error:'JSONを読めません'}, ok, 400) }

    const image = body.image;   // dataURL または base64
    if(!image) return json({error:'imageがありません'}, ok, 400);

    // dataURL を media_type と base64 に分ける
    let mediaType='image/jpeg', b64=image;
    const m = /^data:([^;]+);base64,(.*)$/s.exec(image);
    if(m){ mediaType=m[1]; b64=m[2] }
    if(!IMAGE_TYPES.includes(mediaType)) return json({error:'画像の形式が違います'}, ok, 415);
    if(b64.length > 3_000_000) return json({error:'画像が大きすぎます'}, ok, 413);   // アプリは1024px以下に縮めて送る

    const busy = await checkLimit(env, request, ctx);
    if(busy) return new Response(JSON.stringify({error:busy, busy:true}), {
      status:429, headers:{ 'Content-Type':'application/json; charset=utf-8', 'Retry-After':'60', ...cors(ok) }
    });

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
          .map(c=>`- id:${clip(c.id,40)} / ${clip(c.category,20)} / ${clip(c.color,20)||'色不明'} / ${clip(c.size,20)} / ${clip(c.brand)}`)
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
