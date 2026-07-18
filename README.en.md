# Yurumeet Mobile

Talk-first Tauri client for the shared Yurucommu family API. It owns the
`yurume` client identity and a separate bundle/release lifecycle from
Yurucommu Mobile. Connections can arrive from Takosumi, QR, or a manually
entered HTTPS server; OIDC PKCE and host password sessions are both supported.
The first-run surface also exposes the product's direct Deploy to Cloudflare
flow before returning to normal URL or QR connection.

```sh
bun run bootstrap
bun run mobile:check
```

The checkout must have the Takosumi source beside this repository as
`../takosumi`. `bootstrap` installs the locked shared source modules and this
app's locked dependencies, including the explicit mobile-kit and contract
packages.

`bun run mobile:native-release-check` and
`bun run mobile:release-evidence-check` define native/store completion. Set
`VITE_YURUMEET_NOTIFICATION_PUSHER_GATEWAY_URL` only to the public pusher
gateway URL; APNs/FCM credentials stay gateway-owned.
