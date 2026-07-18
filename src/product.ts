import type { MobileProductAdapter } from "@takosjp/takosumi-mobile-kit";

export const productAdapter: MobileProductAdapter = {
  product: "yurume",
  discoveryProduct: "yurucommu",
  appName: "Yurumeet",
  hostNoun: "Yurucommu family server",
  hostCenterLabel: "Takosumi",
  hostCenterUrl: "https://app.takosumi.com/new",
  hostCenterProduct: "yurumeet",
  hostCenterSource: { git: "https://github.com/tako0614/yurumeet.git" },
  directDeployLabel: "Cloudflare",
  directDeployUrl:
    "https://deploy.workers.cloudflare.com/?url=https://github.com/tako0614/yurumeet",
  directDeployDescription: "Cloudflareへ直接デプロイして接続する",
  acceptedConnectProducts: ["yurume", "yurucommu"],
  urlPlaceholder: "https://your-yurumeet.example",
  primaryActionLabel: "つなぐ",
  accentColor: "#ff3b3f",
  mobileScheme: "yurume",
  oidcScopes: ["openid", "profile", "email", "offline_access"],
};
