import { batch, createRoot, createSignal, getOwner, onCleanup, type JSX } from "solid-js";
import type { NativeBridge } from "@takosjp/mobile-kit";
import {
  type MobileClientAppProps,
  type MobileShellHomeExtraContext,
  type MobileShellMetric,
} from "@takosjp/mobile-kit/solid";
import {
  loadHome,
  registerPush,
  unregisterPush,
  type YurumeetMobileHome,
} from "./api.ts";
import { productAdapter } from "./product.ts";
import { TalkScreen } from "./talk-screen.tsx";
import { createTalkHomeLoader } from "./talk-home-loader.ts";

const metrics = [
  { label: "トーク", value: (home) => home?.contacts.length },
  { label: "未読", value: (home) => home?.unread },
  { label: "リクエスト", value: (home) => home?.requestCount },
] satisfies readonly MobileShellMetric<YurumeetMobileHome>[];

export function createYurumeetMobileApp(
  createNativeBridge: () => NativeBridge,
): MobileClientAppProps<YurumeetMobileHome> {
  const loader = createTalkHomeLoader({ loadHome });
  let view: {
    active: boolean;
    revision: number;
    element: JSX.Element;
    dispose: () => void;
    owner: ReturnType<typeof getOwner>;
  } | undefined;

  function TalkHomeBridge(context: MobileShellHomeExtraContext<YurumeetMobileHome> & {
    isActive: () => boolean;
  }) {
    const [home, setHome] = createSignal(context.home);
    const [session, setSession] = createSignal(context.session);
    const release = loader.mount(context, (snapshot) => batch(() => {
      setSession(snapshot.session);
      setHome(snapshot.home);
    }));
    onCleanup(release);
    return (
      <TalkScreen
        home={home()}
        session={session()}
        refreshHome={context.refreshHome}
        isActive={context.isActive}
      />
    );
  }

  function renderTalk(context: MobileShellHomeExtraContext<YurumeetMobileHome>) {
    // The shell evaluates its extension in a reactive insertion. Keep this
    // root across synchronous home/session rerenders, rather than remounting
    // the conversation on every read ACK's root refresh.
    const owner = getOwner();
    if (!owner) throw new Error("トーク画面の表示先を確認できませんでした。");
    if (view && view.owner !== owner) {
      view.active = false;
      view.dispose();
      view = undefined;
    }
    if (!view) {
      const current = {
        active: true, revision: 0, element: undefined as JSX.Element,
        dispose: () => {},
        owner,
      };
      current.element = createRoot((dispose) => {
        current.dispose = dispose;
        return <TalkHomeBridge {...context} isActive={() => current.active} />;
      }, null);
      view = current;
    }
    const current = view;
    current.active = true;
    const revision = ++current.revision;
    onCleanup(() => {
      // Fence callbacks immediately. A synchronous rerender reuses the root;
      // a genuine removal leaves it inactive and disposes it this microtask.
      current.active = false;
      queueMicrotask(() => {
        if (current.active || current.revision !== revision) return;
        current.dispose();
        if (view === current) view = undefined;
      });
    });
    return current.element;
  }

  return {
    adapter: productAdapter,
    createNativeBridge,
    loadHome: loader.load,
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
    renderHomeExtra: renderTalk,
  };
}
