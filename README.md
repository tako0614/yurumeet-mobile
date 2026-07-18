# Yurumeet Mobile

English: [README.en.md](README.en.md)

Yurumeet Mobile は、Yurucommu family 共通の API につなぐ、トーク中心の Tauri 製モバイルクライアントです。
`yurume` の client identity を持ち、Yurucommu Mobile とは別のバンドル・リリースサイクルで進みます。

サーバーへの接続は Takosumi からの引き継ぎ、QR、手入力の HTTPS URL に対応し、初回起動画面からは
製品の Deploy to Cloudflare フローにも進めます。ログインは OIDC PKCE とホストのパスワードセッションの
両方に対応します。

## 始め方

この repo の隣に Takosumi の source checkout が `../takosumi` として必要です。

```sh
bun run bootstrap
bun run mobile:check
```

`bootstrap` は共有 source module とこのアプリの locked 依存 (明示宣言した mobile-kit / contract package を含む)
をインストールします。

## リリースチェック

- `bun run mobile:native-release-check` — native/store 完成の定義。生成プロジェクト・keystore・push 配線・
  native toolchain を確認します
- `bun run mobile:release-evidence-check` — operator 私有の署名・ストア・実機・OIDC・push の証跡を確認します

## 通知

ビルド時に `VITE_YURUMEET_NOTIFICATION_PUSHER_GATEWAY_URL` には公開の pusher gateway URL だけを設定します。
APNs/FCM credential は gateway 側が所有し、アプリには同梱しません。
