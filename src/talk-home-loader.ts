import { talkSessionIdentity } from "./talk-session.ts";
import type { MobileSession } from "@takosjp/mobile-kit";
import type { YurumeetMobileHome } from "./api.ts";

interface Snapshot {
  session: MobileSession;
  home?: YurumeetMobileHome;
}

interface Lifetime extends Snapshot {
  mounted: boolean;
  revision: number;
  pending?: Promise<YurumeetMobileHome>;
  publish?: (snapshot: Snapshot) => void;
}

// The pinned shell supplies plain values to renderHomeExtra. Keep the product
// view current through its owning loader, without changing shared-kit custody.
export function createTalkHomeLoader(options: {
  loadHome: (session: MobileSession) => Promise<YurumeetMobileHome>;
}) {
  let lifetime: Lifetime | undefined;

  function live(current: Lifetime) {
    return lifetime === current;
  }

  function publish(current: Lifetime) {
    if (live(current)) current.publish?.({
      session: current.session,
      home: current.home,
    });
  }

  function mount(snapshot: Snapshot, listener: (snapshot: Snapshot) => void) {
    // Initial loading can precede mounting. Only that unmounted lifetime can
    // be adopted; signing out and back in always creates a new incarnation.
    const current: Lifetime = lifetime && !lifetime.mounted &&
        talkSessionIdentity(lifetime.session) === talkSessionIdentity(snapshot.session)
      ? lifetime
      : { ...snapshot, revision: 0, mounted: false };
    lifetime = current;
    current.mounted = true;
    current.publish = listener;
    publish(current);
    return () => {
      current.publish = undefined;
      if (live(current)) lifetime = undefined;
    };
  }

  async function settle(current: Lifetime): Promise<YurumeetMobileHome> {
    try {
      while (live(current)) {
        const revision = current.revision;
        const session = current.session;
        try {
          const home = await options.loadHome(session);
          if (!live(current)) throw new Error("トークの接続が変更されました。");
          // Every overlap explicitly requested another refresh. Read once more
          // after the prior request, then settle all shell callers together.
          // An older response cannot overwrite a newer root or contact list.
          if (revision !== current.revision) continue;
          current.home = home;
          publish(current);
          return home;
        } catch (cause) {
          if (!live(current)) throw cause;
          if (revision !== current.revision) continue;
          current.home = undefined;
          publish(current);
          throw cause;
        }
      }
      throw new Error("トークの接続が変更されました。");
    } finally {
      current.pending = undefined;
    }
  }

  function load(session: MobileSession): Promise<YurumeetMobileHome> {
    const current: Lifetime = lifetime ?? {
      session: { ...session }, revision: 0, mounted: false,
    };
    lifetime = current;
    const changed = talkSessionIdentity(current.session) !== talkSessionIdentity(session);
    current.session = { ...session };
    if (changed) current.home = undefined;
    publish(current);
    current.revision += 1;
    current.pending ??= Promise.resolve().then(() => settle(current));
    return current.pending;
  }

  return { load, mount };
}
