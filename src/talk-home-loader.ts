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
  work?: {
    pending?: Promise<YurumeetMobileHome>;
    read?: AbortController;
  };
  publish?: (snapshot: Snapshot) => void;
}

function snapshotSession(session: MobileSession): MobileSession {
  return { ...session, productEndpoints: session.productEndpoints ? { ...session.productEndpoints } : undefined };
}

// The pinned shell supplies plain values to renderHomeExtra. Keep the product
// view current through its owning loader, without changing shared-kit custody.
export function createTalkHomeLoader(options: {
  loadHome: (session: MobileSession, signal?: AbortSignal) => Promise<YurumeetMobileHome>;
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
      : { ...snapshot, session: snapshotSession(snapshot.session), revision: 0, mounted: false };
    const previous = lifetime;
    lifetime = current;
    if (previous !== current) previous?.work?.read?.abort();
    current.mounted = true;
    current.publish = listener;
    publish(current);
    return () => {
      current.publish = undefined;
      if (live(current)) lifetime = undefined;
      current.work?.read?.abort();
    };
  }

  async function settle(current: Lifetime, work: NonNullable<Lifetime["work"]>): Promise<YurumeetMobileHome> {
    const owns = () => live(current) && current.work === work;
    try {
      while (owns()) {
        const revision = current.revision;
        const session = snapshotSession(current.session);
        const read = new AbortController();
        work.read = read;
        try {
          const home = await options.loadHome(session, read.signal);
          if (!owns()) throw new Error("トークの接続が変更されました。");
          // Every overlap explicitly requested another refresh. Read once more
          // after the prior request, then settle all shell callers together.
          // An older response cannot overwrite a newer root or contact list.
          if (revision !== current.revision) continue;
          current.home = home;
          publish(current);
          return home;
        } catch (cause) {
          if (!owns()) throw cause;
          if (revision !== current.revision) continue;
          current.home = undefined;
          publish(current);
          throw cause;
        } finally {
          if (work.read === read) work.read = undefined;
        }
      }
      throw new Error("トークの接続が変更されました。");
    } finally {
      // A retired identity may finish after a replacement read has begun.
      // Only the work that owns this pending slot may release it.
      if (current.work === work) current.work = undefined;
    }
  }

  function load(session: MobileSession): Promise<YurumeetMobileHome> {
    const current: Lifetime = lifetime ?? {
      session: snapshotSession(session), revision: 0, mounted: false,
    };
    lifetime = current;
    const changed = talkSessionIdentity(current.session) !== talkSessionIdentity(session);
    current.session = snapshotSession(session);
    if (changed) {
      current.home = undefined;
      current.work?.read?.abort();
      current.work = undefined;
    }
    publish(current);
    current.revision += 1;
    const work = current.work ??= {};
    work.pending ??= Promise.resolve().then(() => settle(current, work));
    return work.pending;
  }

  return { load, mount };
}
