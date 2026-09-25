# kazokuro-api（AIの受け口）

家族ローゼットから写真を受け取り、AI（Claude）に渡して結果を返す中継サーバー。
Cloudflare Workers で動いている。本体は `worker.js` の1ファイル。

- AIのキーは Cloudflare の設定（Secret）にだけ置く。このファイルには書かない
- 写真はどこにも保存しない
- 接続元ごとにAIの回数を数えて、使いすぎを断る（D1 をつないだときだけ）

## 変えたときの反映のしかた（パソコンで）

1. https://github.com/amekaigan/kazokuro/blob/main/worker/worker.js を開き、右上の「Copy raw file」（コピーのボタン）を押す
2. Cloudflare → 「Workers & Pages」→「kazokuro-api」→ 右上の「Edit code」
3. 左の `worker.js` の中身を全部消して貼り付け、右上の「Deploy」
4. https://kazokuro-api.ishimonzukan.workers.dev/health を開いて `"ok":true` が出ればOK

## 回数の制限をつなぐ（はじめの1回だけ）

1. Cloudflare の左のメニュー「Storage & Databases」→「D1 SQL Database」→「Create」
   - 名前：`kazokuro-db` → 作成
2. 「Workers & Pages」→「kazokuro-api」→「Settings」→「Bindings」→「Add」→「D1 database」
   - Variable name：`DB`
   - D1 database：`kazokuro-db` → 保存（Deploy）
3. /health を開いて `"limit":true` になっていればOK

表は最初にAIを使ったときに自動で作られる。

## 上限を変えたいとき

「Settings」→「Variables and Secrets」で次を足す（書かなければ右の数字）。

| 名前 | 意味 | 省略時 |
|---|---|---|
| LIMIT_PER_MIN | 同じ接続元から1分に何回まで | 60 |
| LIMIT_PER_DAY | 同じ接続元から1日に何回まで | 400 |
| LIMIT_GLOBAL_DAY | 全員あわせて1日に何回まで | 3000 |
| HASH_SALT | 接続元を元に戻せない形にするときに混ぜる文字（Secret で。なくても動く） | — |

- 1日の区切りは日本時間の0時
- まとめて登録は2枚ずつ送るので、1分に30〜40回くらいになる。1分の上限は60より下げない
- 家族で同じWi-Fiを使っていると同じ接続元になる。1日400回は、はじめの日に家族2人が200着ずつ登録しても足りる数
- 断られたとき、アプリは「今日はAIをたくさん使いました…」などの理由を出し、残りは手で選ぶ形になる

## 数えかた

- 接続元（IPアドレス）は、日ごとに変わる文字を混ぜて元に戻せない形（ハッシュ）にしてから数える。IPアドレスそのものは残らない
- 記録は2日たったら消える
- 1人が連打しても、断られた分は「全員あわせた回数」には入れない（1人で全員を止められないように）
- D1 が止まっているときや数えられないときは、断らずに通す
