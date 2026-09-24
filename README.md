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

## 始め方

この repo の隣に Takosumi の source checkout が `../takosumi` として必要です。

```sh
bun run bootstrap
bun run mobile:check
```

`bootstrap` は共有 source module とこのアプリの locked 依存 (明示宣言した mobile-kit / contract package を含む)
をインストールします。
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

## 通知

ビルド時に `VITE_YURUMEET_NOTIFICATION_PUSHER_GATEWAY_URL` には公開の pusher gateway URL だけを設定します。
APNs/FCM credential は gateway 側が所有し、アプリには同梱しません。
