# Yurumeet Mobile

English: [README.en.md](README.en.md)

Yurumeet Mobile は、Yurucommu family 共通の API につなぐ、トーク中心の Tauri 製モバイルクライアントです。
`yurume` の client identity を持ち、Yurucommu Mobile とは別のバンドル・リリースサイクルで進みます。
iOS / Android 専用で、desktop artifact は配布しません。

サーバーへの接続は Takosumi からの引き継ぎ、QR、手入力の HTTPS URL に対応し、初回起動画面からは
製品の Deploy to Cloudflare フローにも進めます。ログインは OIDC PKCE とホストのパスワードセッションの
両方に対応します。

接続先には `client.yurume.messages.v1` capability を要求します。OIDC は PKCE 後に family host の
session へ交換するため、provider の `offline_access` や refresh token は要求・保存しません。Takosumi から受け取る
setup ticket は接続先を引き継ぐための未検証参照であり、認証やデプロイ完了の証明として扱いません。また、native
session を外部ブラウザへ渡す one-time handoff contract ができるまでは、認証済み web route のショートカットを表示せず、
deep link / push から外部 route を開きません。

トークの成功応答は読み込み時に検証します。応答が壊れている場合は「トークなし」として扱わず、
エラーからトークを更新できます。送信結果を確認できないときは本文を残し、自動で再送しません。
再送する前にトークを更新して届いているか確認してください。添付だけのメッセージは添付件数を表示します。

## 始め方

```sh
bun run bootstrap
bun run mobile:check
```

`bootstrap` は `bun install --frozen-lockfile` でこのアプリの locked 依存をインストールします。
desktop 向けの `bun run tauri:dev` / `bun run tauri:build` は exit 64 で停止します。native 実行・build は
`tauri:android:*` または `tauri:ios:*` を使います。

## リリースチェック

- `bun run mobile:native-release-check` — native/store 完成の定義。生成プロジェクト・keystore・push 配線・
  native toolchain を確認します
- `bun run mobile:release-evidence-check` — operator 私有の署名・ストア・実機・OIDC・push の証跡を確認します

[`release/mobile-release-evidence.example.json`](release/mobile-release-evidence.example.json) は全項目が
`not-run` の入力例です。実測した private evidence から `release/mobile-release-evidence.json` を作るまで release gate は
安全側に停止のままです。artifact と evidence を独立 verifier が検証した後、exact evidence SHA-256、
`tauri.conf.json` 由来の product identity / version、private `verifierRef` を持つ
`release/mobile-release-attestation.json` を生成します。実 evidence / attestation は両方とも gitignore 対象で、
repo 内のテンプレートを verified evidence として扱いません。

## リンク（Takosumi から開く・画面へのリンク）

Takosumi は、このアプリを専用アプリとして開くとき、信頼できる専用アプリの一覧（`com.yurumeet`、scheme `yurume`、
カタログの product `yurumeet`）にある雛形に画面のURLのoriginを URL encode して入れ、次のどちらかを送ります。

- `yurume://connect?host_url=<origin>`
- `yurume://connect?host_url=<origin>&product=yurumeet`

アプリはどちらも受け付けます（自動ではサインインしません）。

- サインインしていなければ、そのサーバーを見つけてサインインの手前まで進みます。
- 別のサーバーにサインイン中なら、今のセッションはそのまま使えるようにしたまま、そのサーバーを「別の接続先」として
  出し、保存したアカウントへの切り替えか、サインインして追加するかを利用者が選びます。黙って切り替えません。
- 同じサーバーにサインイン中なら、何も尋ねずにアプリを開くだけです。

画面へのリンク `yurume://open?path=/…`（`host_url=` 付きも可）と `yurume://open?url=https://<サーバー>/…` は、
接続中のサーバーと同じoriginの絶対pathだけを受け付けます。http(s) 以外のURL、別のoriginへ解決されるもの
（`//host`、`/\host`）、空白・制御文字、2,048文字を超えるものは、開く前に拒否します。認証情報らしい名前
（`code`・`token`・`access_token`・`session`、`…_token` など）の query・fragment・path 引数を持つものも
拒否しますが、これは名前の一覧と語尾による best effort の検査で、ほかの名前に入った認証情報は通ります。
`/join?code=…` のように `code` を使うリンクも開きません（mobile-kit の `allowRouteCodeParameter` は使っていません）。

- `/`（web の `/?tab=talk` を含む。Takosumi の画面のURLはこれ）は、トークの画面で開きます。
- それ以外の画面はアプリに無いため、トークの画面のままで「リンク先の画面はアプリにありません」と知らせます。
  上のとおり、外部ブラウザでは開きません。
- 別の保存済みサーバーへのリンクは、そのサーバーを出して利用者の切り替えを待ち、切り替えた後に開きます。
  サインインしていなければ、サインインの後に開きます。
- 通知をタップしたときは、これまでどおりトークの画面を開きます。

ストアのIDが決まるまで、Takosumi 側の画面の Interface には `clients` を書きません。universal link・App Links
（配布者のドメイン）も未設定です。

## 通知

ビルド時に `VITE_YURUMEET_NOTIFICATION_PUSHER_GATEWAY_URL` には公開の pusher gateway URL だけを設定します。
APNs/FCM credential は gateway 側が所有し、アプリには同梱しません。
