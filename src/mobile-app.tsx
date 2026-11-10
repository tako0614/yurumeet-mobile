import { batch, createRoot, createSignal, getOwner, onCleanup, Show, type JSX } from "solid-js";
import type { NativeBridge, MobileSession } from "@takosjp/mobile-kit";
import {
  MobileClientApp,
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
import { HostRouteNoticeBanner, TalkScreen } from "./talk-screen.tsx";
import { createTalkHomeLoader } from "./talk-home-loader.ts";
import { updateTalkNotificationRequest, type TalkNotificationRequest } from "./talk-notification.ts";
import { talkSessionIdentity } from "./talk-session.ts";
import { createHostRouteHandoff, type HostRouteNotice } from "./host-route.ts";
import {
  createAndroidBackNavigation,
  type AndroidBackFailure,
  type AndroidBackRegistrar,
  type BackAction,
} from "./android-back-navigation.ts";

const metrics = [
  { label: "トーク", value: (home) => home?.contacts.length },
  { label: "未読", value: (home) => home?.unread },
  { label: "リクエスト", value: (home) => home?.requestCount },
] satisfies readonly MobileShellMetric<YurumeetMobileHome>[];

export function YurumeetMobileApp(props: {
  createNativeBridge: () => NativeBridge;
  registerAndroidBack?: AndroidBackRegistrar;
}) {
  const app = createYurumeetMobileApp(props.createNativeBridge, props.registerAndroidBack);
  onCleanup(() => { void app.disposeAndroidBack(); });
  return <><app.BackRecovery /><MobileClientApp {...app} /></>;
}

export function createYurumeetMobileApp(
  createNativeBridge: () => NativeBridge,
  registerAndroidBack?: AndroidBackRegistrar,
): MobileClientAppProps<YurumeetMobileHome> & {
  BackRecovery: () => JSX.Element;
  disposeAndroidBack: () => Promise<void>;
} {
  const [backFailure, setBackFailure] = createSignal<AndroidBackFailure>();
  const androidBack = registerAndroidBack
    ? createAndroidBackNavigation({ register: registerAndroidBack, onFailure: setBackFailure })
    : undefined;
  const loader = createTalkHomeLoader({ loadHome });
  const [notification, setNotification] = createSignal<TalkNotificationRequest>();
  function resetNotifications() { setNotification(undefined); }
  function loadSelectedHome(session: MobileSession) {
    const key = talkSessionIdentity(session);
    setNotification(current => current?.sessionKey === key ? current : undefined);
    return loader.load(session);
  }
  // Route links (`yurume://open?path=…` / `?url=…`) open on the talk screen; a
  // route without a native screen is reported here instead of a browser.
  const [routeNotice, setRouteNotice] = createSignal<HostRouteNotice>();
  const openHostRoute = createHostRouteHandoff(setRouteNotice);
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
    const backOwner = {};
    const setBackTarget = (back: BackAction | undefined) => {
      if (back) void androidBack?.setTarget({
        owner: backOwner, scope: talkSessionIdentity(session()),
        isActive: context.isActive, back,
      });
      else void androidBack?.clear(backOwner);
    };
    onCleanup(() => { void androidBack?.clear(backOwner); });
    const release = loader.mount(context, (snapshot) => batch(() => {
      setSession(snapshot.session);
      setHome(snapshot.home);
    }));
    onCleanup(release);
    return (
      <>
        <HostRouteNoticeBanner
          notice={routeNotice()}
          session={session()}
          onDismiss={() => setRouteNotice(undefined)}
        />
        <TalkScreen
          onBackTarget={setBackTarget}
          home={home()}
          session={session()}
          refreshHome={context.refreshHome}
          isActive={context.isActive}
          notificationRequest={notification()}
          onNotificationConsumed={(request) => setNotification(current => current === request ? undefined : current)}
        />
      </>
    );
  }

  function renderTalk(context: MobileShellHomeExtraContext<YurumeetMobileHome>) {
    // The shell evaluates its extension in a reactive insertion. Keep this
    // root across synchronous home/session rerenders, rather than remounting
    // the conversation on every read ACK's root refresh.
    const owner = getOwner();
    if (!owner) throw new Error("トーク画面の表示先を確認できませんでした。");
    if (view && view.owner !== owner) {
      const key = talkSessionIdentity(context.session);
      setNotification(current => current?.sessionKey === key ? current : undefined);
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
        if (view === current) { view = undefined; resetNotifications(); }
      });
    });
    return current.element;
  }

  return {
    // Remains reachable after the account-owned talk view is retired.
    BackRecovery: () => <Show when={backFailure()}>
      <div role="alert">
        <p>Androidの戻る操作を更新できませんでした。画面内の「戻る」を使い、再接続を試してください。</p>
        <button type="button" class="text-button" onClick={() => void androidBack?.retry()}>
          Androidの戻る操作を再接続
        </button>
      </div>
    </Show>,
    disposeAndroidBack: () => androidBack?.dispose() ?? Promise.resolve(),
    adapter: productAdapter,
    createNativeBridge,
    loadHome: loadSelectedHome,
    registerPush,
    unregisterPush,
    openHostRoute,
    // A push is only a session-bound hint. The foreground view resolves the
    // event using its authenticated actor before opening a native chat.
    handlePushNotification: (input) => {
      if (input.kind !== "tapped") return false;
      // The kit invokes this callback only for its current session/epoch.
      // A cold tap can precede that session's first home read or view mount.
      setNotification(current => updateTalkNotificationRequest(current, input));
      return true;
    },
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
    // and there is no one-time browser-session handoff contract yet. Route
    // links go through `openHostRoute`, which only opens native screens.
    hostActions: [],
    renderHomeExtra: renderTalk,
  };
}
