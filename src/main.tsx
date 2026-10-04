import {
  renderMobileClientApp,
  type MobileShellMetric,
} from "@takosjp/mobile-kit/solid";
import {
  loadHome,
  registerPush,
  unregisterPush,
  type YurumeetMobileHome,
} from "./api.ts";
import { createProductNativeBridge } from "./native.ts";
import { productAdapter } from "./product.ts";
import { TalkScreen } from "./talk-screen.tsx";
import "./styles.css";

const metrics = [
  { label: "トーク", value: (home) => home?.contacts.length },
  { label: "未読", value: (home) => home?.unread },
  { label: "リクエスト", value: (home) => home?.requestCount },
] satisfies readonly MobileShellMetric<YurumeetMobileHome>[];

renderMobileClientApp<YurumeetMobileHome>({
  adapter: productAdapter,
  createNativeBridge: createProductNativeBridge,
  loadHome,
  registerPush,
  unregisterPush,
  sessionUnlock: {
    restoreMode: "if-available",
    prompt: {
      title: "Yurumeet",
      message: "トークを開きます",
      allowDeviceCredential: true,
    },
  },
  homeLabel: "トーク",
  copy: {
    eyebrow: "TALK WITH YOUR PEOPLE",
    // Mirror of yurumeet/public/yurumeet-logo.png; `brandMark` stays as the
    // fallback glyph.
    brandLogoUrl: "/brand/yurumeet.png",
    brandMark: "YURU",
    onboardingTitle: "いつもの人と、話そう",
    summary: "自分たちのサーバーでつながる、やさしいトーク。",
    // Mirror of takosumi/dashboard/public/tako.png, the canonical Takosumi
    // mark named by docs/reference/design-language.md, instead of a "T".
    hostCenterIconUrl: "/brand/takosumi.png",
    takosumiActionLabel: "Takosumiで始める",
    takosumiActionDescription: "Takosumiで作ったトーク環境に接続",
    manualActionLabel: "サーバーを自分で入力",
    manualActionDescription: "CloudflareやセルフホストのURLを使用",
    connectLabel: "サーバーURL",
    qrActionLabel: "接続QRを読み取る",
    discoveredHeading: "サーバーが見つかりました",
    homeFallbackTitle: "トーク",
    refreshLabel: "更新",
    homeTitle: (home) => home?.actor.name ?? home?.actor.preferred_username,
    metricsLabel: "トーク概要",
    shortcutsLabel: "メニュー",
  },
  metrics,
  // Talk and contacts are native below. Do not open authenticated web routes
  // in an external browser: the host session is scoped to this native client
  // and there is no one-time browser-session handoff contract yet.
  hostActions: [],
  renderHomeExtra: ({ home, session, refreshHome }) => (
    <TalkScreen home={home} session={session} refreshHome={refreshHome} />
  ),
});
