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
エラーからトークを更新できます。送信結果が不明な場合（通信切断・壊れた成功応答・追従しないredirect・HTTP 408/5xx）は本文を残し、
次の送信を止めます。トークを更新して届いているか確認してください。更新に失敗した間は送信を再開せず、
成功しても自動で再送しません。更新中や送信中に書いた新しい本文も保持します。サーバーによる重複排除を
保証する機能ではないため、確認後の再送は利用者が判断します。

DMとグループの画像・動画は、メッセージの「画像を表示」「動画を表示」からアプリ内で開けます。
JPEG/PNG/GIF/WebP、MP4/WebMに対応し、未対応形式はその旨を表示します。勝手には取得せず、
接続中サーバーのmediaだけに現在のsessionを送り、redirectは追従しません。同サーバーの応答全体に15秒、
画像20MiB・動画40MiBのアプリ読込上限を設けます。外部HTTPS添付はnative HTTPを使わず、WebViewの通常の
画像・動画表示で読み込みます。認証情報・cross-origin cookie・referrerを送らず、接続先のCORSとOSのcodecに従います。
同じ添付は新着確認後も表示を保持します。読込失敗・表示失敗は明示的に再試行でき、会話から戻る・画面を隠す・account変更で読込と一時URLを破棄します。
接続先のmedia閲覧権限はサーバーが判断し、未取得の添付を表示済みとしません。実OSのcodecや配布資格は別の確認が必要です。

「写真・動画」から8件まで選ぶと、接続先の正規media upload APIで準備し、本文なしでも送れます。
準備中・失敗・結果不明の添付がある間は送信しません。失敗した添付は明示retryか「下書きから外す」で回復できます。
uploadの応答は選択した形式・正規media参照・有効な期限を検証し、期限後の再準備を求めます。
添付付きメッセージの成功ACKは本文・作者・添付を照合します。送信中に追加した別ファイルと本文は次の下書きに残ります。
ACK不明時は添付も残し、既存の「トークを更新」で届いた内容を確認するまで再送を止めます。確認後も自動再送しません。
下書きと準備中のuploadは元の会話に属し、会話から戻っても保持します。account変更・sign-outでは取消して破棄します。
下書きから外す操作は保存済みmediaの物理削除ではなく、未送信分の回収はサーバーの既存staged lifetimeに従います。

API の待ち時間は応答本文を含めて 15 秒です。トークから戻ると読み込みを中止し、送信中の処理と下書きは
同じ会話に保持します。サインアウトや接続資格・API 接続先の変更では、以前の読み込み・送信・キャッシュを
破棄し、遅れた応答を新しいアカウントへ表示しません。

DM とグループ会話は最新 50 件から開き、「以前のメッセージを読み込む」で過去の履歴を追加できます。
同時刻のメッセージも ID を含む続きの位置で読み込み、既存の表示・送信確認・下書きを保持します。
失敗したページは同じ位置から明示的に再試行できます。過去の履歴を取得するだけでは既読更新や送信を行わず、
送信結果が不明な状態も解除しません。トークを開き直すと最新ページへ更新します。
追加履歴の有無を返さない旧サーバーでは、不明と表示し、履歴を読み切ったことにはしません。

会話を表示している間は定期的に新着を確認します。「新着を確認」でも更新でき、下書きと読込済み履歴を
保持します。最新ページを超える受信で未確認の区間ができた場合は、その位置に表示される操作から
間のメッセージを取得できます。区間を確認してから、画面内に見えているメッセージのIDだけを既読にします。読込中や、
取得しただけで画面外のメッセージは既読にしません。画面を隠す・会話から戻る・
接続先を変えると新着取得を中止し、遅れた応答を反映しません。取得に失敗した場合は自動取得を止め、
明示的な確認、画面への復帰、接続回復で再確認します。自動取得で送信結果不明の状態を解除したり、再送したりしません。

会話を開くには、family Coreの0037 schemaと`read-observed/init`・`read-observed` v1が必要です。
初期化を確認してからページを取得し、表示ID限定のACKを最大50件・32KiBごとに送ります。
ACK本文を検証できない場合は処理を止め、旧時刻ベースの`/read`へ自動で戻りません。
別の旧clientが明示的に行う「会話全体を既読」操作は、そのclientの既存の意味のままです。
これはsource上の必要契約であり、既存サービスへのschema適用・公開を示しません。

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
query・fragment・path 引数の名前は英数字などのASCIIに限ります。全角の英字はASCIIにそろえてから判定し、それ以外の
ASCIIでない名前（`?名前=…` など）を持つリンクは開きません。似た文字で認証情報の名前を作れないようにするためです。
値やアンカーにASCIIでない文字があるのは構いません。

- `/`（web の `/?tab=talk` を含む。Takosumi の画面のURLはこれ）は、トークの画面で開きます。
- それ以外の画面はアプリに無いため、トークの画面のままで「リンク先の画面はアプリにありません」と知らせます。
  上のとおり、外部ブラウザでは開きません。
- 別の保存済みサーバーへのリンクは、そのサーバーを出して利用者の切り替えを待ち、切り替えた後に開きます。
  サインインしていなければ、サインインの後に開きます。
- 通知タップは、ログイン中の本人で `/api/dm/notification-target` を確認し、対象のDMまたはグループを
  専用App内で開きます。通知のevent IDやmessage object IDから相手を推測しません。
  本人のhome読取と前面表示を待ち、接続変更・画面破棄・次のタップでは古い解決処理を中止します。
  受信しただけでは会話を開いたり既読にしたりしません。
- サーバー未対応・削除・失効などで通知先を確認できないときはエラーと明示的な再確認を表示し、
  一覧と下書きを保持します。対応するserver APIが必要であり、実OSの通知配信・起動の検証とは別です。

ストアのIDが決まるまで、Takosumi 側の画面の Interface には `clients` を書きません。universal link・App Links
（配布者のドメイン）も未設定です。

## 通知

DMの本人メッセージには「編集」「削除…」を表示します。現在の1件を本人権限で読み直し、
その状態に対する変更だけを条件付きで保存します。編集欄は新規送信の本文とは別で、保存待ち中の追加入力も残ります。
削除は確認dialogから実行し、応答不明や競合時は再送せず「現在の1件を確認」で状態を照合します。
最新50件に無い古いメッセージも1件読取で確認し、未対応hostの404を削除成功と扱いません。
別の会話へ戻っても、その会話の下書きと処理結果を保ち、接続・本人の切替では古い処理を破棄します。
DM操作にはhostのowned-DM読取APIが必要です。グループの本人メッセージにも「編集」を表示し、
community専用の1件読取・group revisionで保存します。現在の閲覧権限と本人の投稿だけが対象です。
未対応hostや権限失効は編集欄から再確認でき、汎用404で本文を消しません。他人のメッセージ操作は提供しません。
グループの本人メッセージも「削除…」から、現在の本文を確認して削除できます。1件GETで条件付き削除への
対応を確認できない旧hostにはDELETEを送りません。確認取消しでは変更せず、競合は現在本文を再確認してから
再度確認します。応答喪失時は自動再送せず、対応する1件読取の不存在だけで完了を照合します。
メッセージの変更・確認中や確認dialogの表示中は、背後のメッセージを既読にしません。
DMではこのサーバーの保存状態を変更し、外部宛先へは既存の配送予約を使います。グループ編集は現在の
community保存状態を変更し、既存の再取得で反映します。新たな外部配送契約は追加しません。相手側の最終反映や
受信側の採用状況を、このAppのsource/local実装だけで閉じたとは扱いません。

トーク一覧の「メッセージリクエスト」から、本人宛てのリクエストを確認できます。
相手の現在のトークを開くだけでは承認されず、返信を送った時点で承認されます。
既読は通常の会話と同じ表示済みIDに限定します。「受信トークを拒否」は確認後に、相手との
現在のトークの受信メッセージを削除します。ブロックはせず、同じ相手の古い別履歴は残り得ます。
拒否後はサーバーの一覧を再取得し、応答不明の場合は再実行せず、明示的な一覧更新を求めます。
拒否には `/api/dm/requests/reject-pending` 対応hostが必要です。古いhostの従来の削除APIへは戻りません。
接続切替や画面移動で古い応答を採用せず、別の会話の下書きと未確認の送信結果は保ちます。

ビルド時に `VITE_YURUMEET_NOTIFICATION_PUSHER_GATEWAY_URL` には公開の pusher gateway URL だけを設定します。
APNs/FCM credential は gateway 側が所有し、アプリには同梱しません。
