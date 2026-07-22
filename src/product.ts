import type { MobileProductAdapter } from "@takosjp/mobile-kit";

export const productAdapter: MobileProductAdapter = {
  product: "yurume",
  discoveryProduct: "yurucommu",
  appName: "Yurumeet",
  // Reads inside Japanese status sentences, so the noun is Japanese too.
  hostNoun: "Yurucommu family サーバー",
  hostCenterLabel: "Takosumi",
  hostCenterUrl: "https://app.takosumi.com/new",
  hostCenterProduct: "yurumeet",
  hostCenterSource: { git: "https://github.com/tako0614/yurumeet.git" },
  directDeployLabel: "Cloudflare",
  directDeployUrl:
    "https://deploy.workers.cloudflare.com/?url=https://github.com/tako0614/yurumeet",
  directDeployDescription: "Cloudflareへ直接デプロイして接続する",
  // `yurumeet` is here because the Host Center return deep link echoes back the
  // catalog key we hand it in `hostCenterProduct`, not this app's client key.
  acceptedConnectProducts: ["yurume", "yurucommu", "yurumeet"],
  urlPlaceholder: "https://your-yurumeet.example",
  primaryActionLabel: "つなぐ",
  // Yurumeet brand red, kept equal to the accent declared in
  // `yurumeet/src/styles.css`.
  accentColor: "#ff3b3b",
  mobileScheme: "yurume",
  oidcScopes: ["openid", "profile", "email", "offline_access"],
};
