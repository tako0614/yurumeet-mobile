# Yurumeet Mobile

Use **New talk** on the talk list to find a person by name/username or
`@user@server`. The selected host performs the search; native credentials are
never sent directly to the remote server. Results display the actor ID, and
choosing a person resolves that exact ID through the authenticated contact API
before opening the existing conversation. Search and selection do not follow
anyone or send a message. Send remains an explicit action under the server's
existing permissions. Failed searches can be retried explicitly; changing the
query, closing search or changing the account/server discards late responses.

日本語: [README.md](README.md)

Talk-first Tauri client for the shared Yurucommu family API. It owns the
`yurume` client identity and a separate bundle/release lifecycle from
Yurucommu Mobile. It is distributed for iOS and Android only; desktop
artifacts are intentionally disabled. Connections can arrive from Takosumi,
QR, or a manually entered HTTPS server; OIDC PKCE and host password sessions
are both supported. The first-run surface also exposes the product's direct
Deploy to Cloudflare flow before returning to normal URL or QR connection.

The client requires the host capability `client.yurume.messages.v1`. OIDC is
exchanged for a family-host session, so the app does not request
`offline_access` or retain a provider refresh token. A setup ticket received
from Takosumi is an unverified connection hint, not proof of authentication or
deployment completion. Authenticated web shortcuts remain hidden until the
host defines a one-time browser-session handoff; deep links and push events do
not open authenticated routes in an external browser either.

Talk responses are validated before display. An invalid response shows an error instead of an empty conversation;
use the talk refresh action to read it again. An unknown send result (a disconnected request, malformed successful
response, a non-followed redirect, or HTTP 408/5xx) retains the draft and blocks further sends until a successful conversation refresh.
A failed refresh keeps sends blocked; a successful refresh never resends automatically. Edits made while reading
or sending are preserved. This does not provide server-side deduplication: inspect the conversation before
deciding to send again.

DM and group attachments open inside the app through explicit image/video buttons. JPEG/PNG/GIF/WebP and
MP4/WebM are supported; other formats remain visibly unavailable. Reads are lazy. Only the selected server's
canonical media route receives the current session; its reads refuse redirects and have a 15-second whole-body
deadline with client buffering ceilings of 20 MiB for images and 40 MiB for videos. External HTTPS attachments
use ordinary WebView media elements rather than native HTTP authority, omit cross-origin credentials and
referrers, and follow browser CORS and OS codec support. Loading and decoding failures offer an explicit retry.
Refreshing unchanged messages keeps opened media. Leaving the conversation, hiding the app or changing accounts cancels reads and revokes temporary blob URLs.
The server still decides media access. OS codec support and native distribution require separate validation.

Choose up to eight supported files through the photo/video field. The app prepares them through the selected
host's existing multipart media upload API, and can send an attachment-only message. Queued, failed or
unconfirmed uploads block sending; retry or remove a file explicitly. Upload acknowledgments must match
the selected format and canonical media identity and include a valid future expiry; expired files require preparation again.
Attachment-message ACKs bind the submitted author, text and attachments. Files and text added during a send survive
as the next draft. An unknown send result retains the attachments and uses the existing explicit conversation
readback fence, without automatic resend. Drafts/uploads belong to their original conversation and survive
Back; account changes or sign-out cancel and discard them. Removing a draft attachment does not physically
delete settled media; the host's existing staged-media lifetime owns unreferenced upload collection.

API requests have a 15-second budget including the response body. Leaving a conversation cancels its read while
retaining its pending send and draft. Sign-out or a change of credentials or API destination retires prior reads,
sends and cached conversation data, so late responses cannot appear in the next account.

Own DM messages expose native edit and confirmed delete actions. A fresh author-only single-message read supplies
the exact conditional revision; compose and edit drafts remain separate, including newer input during a save ACK.
Unknown mutation results and conflicts require explicit single-message readback, never automatic resend. This works
for older loaded messages outside the latest page; an unsupported host404 is not deletion proof. Switching actors or
sessions retires prior work, while changing conversations preserves that conversation's draft and pending result.
DM actions require the host's owned-DM reader. Own group messages also expose edit through the community-specific
single-message reader and group revision. Current read access and authorship remain required. Unsupported hosts or
revoked access require explicit rechecking; a generic404 never removes the message. Actions on another author's
messages are not offered. Own Group messages also expose a confirmation-based Delete. The single-message GET
must advertise the exact conditional-delete contract before any DELETE; an older editing-only host is refused.
Cancellation performs no write, conflicts require fresh content and another explicit confirmation, and an unknown
ACK is reconciled through supported per-message absence without an automatic resend.
Read receipts pause during message actions and confirmation dialogs so hidden messages remain unread.
For DMs the server co-commits local changes with explicit-recipient delivery intent, without follower fanout.
Group edits update community chat state and use existing receive-refresh behavior; they add no external delivery contract. Remote arrival
and receiving-host adoption are not qualified by this App's source/local implementation.

The native message-request inbox lists incoming requests for the signed-in account. Opening the peer's current
conversation does not accept it; an explicit reply does. Normal visible-message read receipts still apply.
Rejecting requires confirmation and removes incoming messages in the peer's current conversation without blocking
the peer. An older conversation from the same sender may remain. The app reloads the server list after rejection;
an unknown result requires an explicit list refresh before another destructive action, never an automatic retry.
Rejection requires the host's guarded `/api/dm/requests/reject-pending` API; older hosts fail closed without legacy fallback.
Changing accounts or leaving the inbox retires pending reads and ignores late replies while keeping unrelated drafts.

DMs and group conversations open with the latest 50 messages. Use the older-message action to prepend history;
the timestamp-plus-ID cursor retains messages that share a timestamp. Existing messages, confirmed sends and
drafts stay intact. A failed page can be retried explicitly from the same position. Fetching older history does
not send messages, update read receipts or resolve an unknown send result. Reopening the conversation refreshes
the latest page. Hosts that omit continuation metadata display an unknown history state instead of exhaustion.

An open, visible conversation checks for new messages periodically. The latest-message action also refreshes
without discarding drafts or loaded history. A burst beyond the latest page shows an unchecked interval at
its position, with an action to fetch the missing pages. After intervals are checked, read ACKs name only message rows visible in the viewport;
loading rows and fetched messages outside the viewport are not acknowledged.
Hiding the app, leaving the conversation or changing the connection cancels receive work and ignores late
responses. A failed receive pauses automatic checks until an explicit check, foreground return or network
recovery. Background receive never resolves an unknown send outcome or automatically resends its draft.

Opening a conversation requires family Core schema 0037 and `read-observed/init` / `read-observed` v1.
The app confirms init before fetching messages, then submits visible IDs in batches of at most 50 and 32KiB.
An invalid ACK stops the operation; the app never falls back to timestamp-based `/read`.
An explicit mark-whole-conversation call from another old client keeps that client's weaker semantics.
These are source contract requirements, not evidence of a schema apply or deployment on an existing service.

```sh
bun run bootstrap
bun run mobile:check
```

`bootstrap` runs `bun install --frozen-lockfile` to install this app's locked
dependencies.
The desktop `tauri:dev` and `tauri:build` commands intentionally exit 64. Use
the `tauri:android:*` or `tauri:ios:*` commands for native execution and
builds.

`bun run mobile:native-release-check` and
`bun run mobile:release-evidence-check` define native/store completion. Set
`VITE_YURUMEET_NOTIFICATION_PUSHER_GATEWAY_URL` only to the public pusher
gateway URL; APNs/FCM credentials stay gateway-owned.

### Links (opening from Takosumi, screen links)

When Takosumi opens this app as a screen's native client, it fills the trusted
template for this app (`com.yurumeet`, scheme `yurume`, catalog product
`yurumeet`) with the screen URL's origin, URL-encoded, and sends one of:

- `yurume://connect?host_url=<origin>`
- `yurume://connect?host_url=<origin>&product=yurumeet`

Both are accepted (sign-in is never automatic). Signed out, the app finds the
server and stops before sign-in. Signed in to another server, the current
session stays usable and the server is shown as another host; the user chooses
to switch to a saved account or sign in to add it. Nothing switches silently.
Signed in to the same server, the app just opens.

Screen links `yurume://open?path=/…` (optionally with `host_url=`) and
`yurume://open?url=https://<server>/…` accept only absolute paths on the
connected server's origin. Non-http(s) URLs, paths that resolve to another
origin (`//host`, `/\host`), whitespace or control characters, and more than
2,048 characters are refused before anything opens. Links whose query,
fragment or path parameters have credential-looking names (`code`, `token`,
`access_token`, `session`, `…_token`, …) are refused too, on a best-effort
basis: the check uses a name list and endings, so a credential under another
name still passes. Links with a `code` parameter (such as `/join?code=…`) do
not open either (mobile-kit's `allowRouteCodeParameter` is not enabled).
Parameter names in the query, fragment or path must be ASCII: full-width
letters are folded to ASCII first, and a link with any other non-ASCII name
(such as `?名前=…`) does not open, so lookalike letters cannot spell a
credential name. Non-ASCII values and anchors are fine.

- `/` (including the web client's `/?tab=talk`; a Takosumi screen URL is this)
  opens the talk screen.
- Other screens are not in the app: the talk screen stays and says so. As
  above, they are not opened in an external browser.
- A link for another saved server shows that server and waits for the user to
  switch; the route opens after the switch, or after sign-in when signed out.
- A tap resolves `/api/dm/notification-target` as the signed-in account and opens
  the returned DM or group natively. Event IDs and message object IDs are never
  guessed to be peers. It waits for the authenticated home and foreground view;
  account changes, view disposal and a later tap retire older work. Receiving a
  notification alone does not open a chat or mark messages read.
- An unsupported server, removed target or revoked access shows an error and an
  explicit retry while retaining the list and drafts. This requires the host
  API; real OS push delivery and launch remain separate verification.

Until store IDs exist, Takosumi screen interfaces do not declare `clients`.
Universal links / App Links on a publisher domain are not set up.

`release/mobile-release-evidence.example.json` is a tracked, all-`not-run`
template. The release gate remains fail closed until an operator supplies
measured private evidence as `release/mobile-release-evidence.json`. After an
independent verifier checks the artifacts and evidence, it generates
`release/mobile-release-attestation.json` with the exact evidence SHA-256,
the product identity and version derived from `tauri.conf.json`, and a private
`verifierRef`. Both real files remain gitignored; a repository template is
never treated as verified evidence.
