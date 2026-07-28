# Yurumeet Mobile

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

```sh
bun run bootstrap
bun run mobile:check
```

The checkout must have the Takosumi source beside this repository as
`../takosumi`. `bootstrap` installs the locked shared source modules and this
app's locked dependencies, including the explicit mobile-kit and contract
packages.
The desktop `tauri:dev` and `tauri:build` commands intentionally exit 64. Use
the `tauri:android:*` or `tauri:ios:*` commands for native execution and
builds.

`bun run mobile:native-release-check` and
`bun run mobile:release-evidence-check` define native/store completion. Set
`VITE_YURUMEET_NOTIFICATION_PUSHER_GATEWAY_URL` only to the public pusher
gateway URL; APNs/FCM credentials stay gateway-owned.

`release/mobile-release-evidence.example.json` is a tracked, all-`not-run`
template. The release gate remains fail closed until an operator supplies
measured private evidence as `release/mobile-release-evidence.json`. After an
independent verifier checks the artifacts and evidence, it generates
`release/mobile-release-attestation.json` with the exact evidence SHA-256,
the product identity and version derived from `tauri.conf.json`, and a private
`verifierRef`. Both real files remain gitignored; a repository template is
never treated as verified evidence.
