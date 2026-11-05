import { observedInitAck as initAck, observedMessageAck as readAck } from "./talk-read-fixture.ts";
import { afterEach, expect, test } from "bun:test";
import { createTalkController } from "../src/talk-controller.ts";
import type { TalkContact, TalkMessage } from "../src/api.ts";

const originalFetch = globalThis.fetch;
const controllers: ReturnType<typeof createTalkController>[] = [];
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.dispose());
  globalThis.fetch = originalFetch;
});
const session = {
  product: "yurume" as const, hostUrl: "https://receive.example",
  accessToken: "synthetic-session", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z",
};
const contact: TalkContact = {
  type: "user", ap_id: "https://peer.example/users/buddy", preferred_username: "buddy",
  name: "Buddy", icon_url: null, last_message: null, last_message_at: null, unread_count: 0,
};
function row(index: number): TalkMessage {
  return {
    id: `message-${String(index).padStart(3, "0")}`, content: `Message ${index}`,
    created_at: "2026-11-05T00:00:00.000Z",
    sender: { ap_id: contact.ap_id, preferred_username: "buddy", name: "Buddy" },
  };
}
function page(first: number, last: number, has_more = false) {
  return Response.json({ messages: Array.from({ length: last - first + 1 }, (_, i) => row(first + i)), has_more });
}
function clock() {
  let pending: (() => void) | undefined;
  return {
    schedule(work: () => void, _delay: number) {
      pending = work;
      return () => { if (pending === work) pending = undefined; };
    },
    async tick() {
      const work = pending; pending = undefined; work?.();
      await Bun.sleep(0);
    },
  };
}
function stub(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  onRead?: (init?: RequestInit) => Response,
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(session.hostUrl);
    if (url.pathname.endsWith("/read-observed/init")) return initAck();
    if (url.pathname.endsWith("/read-observed")) return onRead?.(init) ?? readAck(init);
    return handler(url, init);
  }) as typeof fetch;
}
function subject() {
  const timer = clock();
  let foreground = true;
  const controller = createTalkController({
    observedMessageIds: () => controller.state().messages.map(message => message.id),
    session, refreshHome: async () => {},
    receive: { isForeground: () => foreground, schedule: timer.schedule },
  });
  controllers.push(controller);
  return {
    controller, timer,
    hide() { foreground = false; controller.foregroundChanged(); },
    show() { foreground = true; controller.foregroundChanged(); },
  };
}

test("an already open conversation receives another person's new message without discarding its draft", async () => {
  let newest = 2;
  stub(() => page(1, newest));
  const { controller, timer } = subject();
  await controller.open(contact);
  controller.setDraft("Unsent draft");
  newest = 3;
  await timer.tick();
  expect(controller.state().messages.map(message => message.id)).toEqual([row(1).id, row(2).id, row(3).id]);
  expect(controller.state().content).toBe("Unsent draft");
});

test("a new latest page preserves loaded older history and its exhausted continuation", async () => {
  let newest = 60;
  stub(url => url.searchParams.has("before") ? page(1, 10) : page(newest - 49, newest, true));
  const { controller, timer } = subject();
  await controller.open(contact);
  await controller.loadOlder();
  controller.setDraft("Draft while reading history");
  newest = 61;
  await timer.tick();
  expect(controller.state().messages.map(message => message.id)).toEqual(Array.from({ length: 61 }, (_, i) => row(i + 1).id));
  expect(controller.state()).toMatchObject({ content: "Draft while reading history", hasMore: false });
});

test("a burst beyond one producer page exposes and fills its missing interval without losing history", async () => {
  let burst = false;
  stub(url => {
    const before = url.searchParams.get("before");
    if (before?.endsWith(row(56).id)) return page(6, 55, true);
    if (before?.endsWith(row(6).id)) return page(1, 5);
    return burst ? page(56, 105, true) : page(1, 5);
  });
  const { controller, timer } = subject();
  await controller.open(contact);
  controller.setDraft("Keep draft through burst");
  burst = true;
  await timer.tick();
  expect(controller.state().gaps).toEqual([{ beforeId: row(56).id, canLoad: true }]);
  expect(controller.state().messages).toHaveLength(55);
  await controller.loadGap(row(56).id);
  expect(controller.state().gaps).toEqual([{ beforeId: row(6).id, canLoad: true }]);
  await controller.loadGap(row(6).id);
  expect(controller.state().gaps).toEqual([]);
  expect(controller.state().messages.map(message => message.id)).toEqual(Array.from({ length: 105 }, (_, i) => row(i + 1).id));
  expect(controller.state()).toMatchObject({ content: "Keep draft through burst", hasMore: false });
});

test("filling a newer interval does not hide an earlier unfilled interval", async () => {
  let newest = 5;
  stub(url => {
    const before = url.searchParams.get("before");
    if (before?.endsWith(row(156).id)) return page(106, 155, true);
    if (before?.endsWith(row(106).id)) return page(56, 105, true);
    return newest === 5 ? page(1, 5) : page(newest - 49, newest, true);
  });
  const { controller, timer } = subject();
  await controller.open(contact);
  newest = 105; await timer.tick();
  newest = 205; await timer.tick();
  await controller.loadGap(row(156).id);
  await controller.loadGap(row(106).id);
  expect(controller.state().gaps).toEqual([{ beforeId: row(56).id, canLoad: true }]);
  expect(controller.state().messages).toHaveLength(155);
});

test("background receive never unlocks or resends a draft whose send outcome is unknown", async () => {
  let sends = 0;
  stub((_url, init) => {
    if (init?.method === "POST") { sends++; return Response.json({}, { status: 503 }); }
    return page(1, 2);
  });
  const { controller, timer } = subject();
  await controller.open(contact);
  controller.setDraft("Maybe delivered");
  await controller.send();
  await timer.tick();
  await controller.send();
  expect(sends).toBe(1);
  expect(controller.state()).toMatchObject({ content: "Maybe delivered", uncertain: true, canSend: false });
});

test("hiding the app aborts its pending receive and ignores the late page before resuming", async () => {
  let reads = 0, finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  stub((_url, init) => {
    reads++;
    if (reads === 2) {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    return page(1, reads >= 3 ? 3 : 2);
  });
  const s = subject();
  await s.controller.open(contact);
  await s.timer.tick();
  s.hide();
  expect(signal?.aborted).toBe(true);
  finish(page(1, 9)); await Bun.sleep(0);
  expect(s.controller.state().messages).toHaveLength(2);
  await s.timer.tick();
  expect(reads).toBe(2);
  s.show(); await Bun.sleep(0);
  expect(s.controller.state().messages).toHaveLength(3);
});

test.each(["back", "session", "dispose"])("late receive cannot change a view after %s", async action => {
  let reads = 0, finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  stub((_url, init) => {
    if (++reads === 1) return page(1, 2);
    signal = init?.signal as AbortSignal;
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const { controller, timer } = subject();
  await controller.open(contact);
  await timer.tick();
  if (action === "back") controller.back();
  else if (action === "session") controller.updateSession({ ...session, apiBaseUrl: session.hostUrl + "/different" });
  else controller.dispose();
  const before = controller.state();
  expect(signal?.aborted).toBe(true);
  finish(page(1, 9)); await Bun.sleep(0);
  await timer.tick();
  expect(controller.state()).toEqual(before);
  expect(reads).toBe(2);
});

test("only one receive request can run at once and a failure waits for explicit recovery", async () => {
  let reads = 0, finish!: (response: Response) => void;
  stub(() => {
    if (++reads === 1) return page(1, 2);
    if (reads === 2) return new Promise<Response>(resolve => { finish = resolve; });
    return page(1, 3);
  });
  const s = subject();
  await s.controller.open(contact);
  await s.timer.tick(); await s.timer.tick();
  expect(reads).toBe(2);
  finish(Response.json({}, { status: 401 })); await Bun.sleep(0);
  expect(s.controller.state().error).not.toBe("");
  await s.timer.tick(); expect(reads).toBe(2);
  s.controller.foregroundChanged(); await Bun.sleep(0);
  expect(s.controller.state().messages).toHaveLength(3);
});

test("a send ACK survives a receive started earlier and later stale pages until observed", async () => {
  let reads = 0, newest = 2, finish!: (response: Response) => void;
  stub((_url, init) => {
    if (init?.method === "POST") return Response.json({ message: row(3) });
    if (++reads === 2) return new Promise<Response>(resolve => { finish = resolve; });
    return page(1, newest);
  });
  const { controller, timer } = subject();
  await controller.open(contact);
  await timer.tick();
  controller.setDraft("Sent once"); await controller.send();
  finish(page(1, 2)); await Bun.sleep(0);
  await timer.tick();
  expect(controller.state().messages.map(message => message.id)).toEqual([row(1).id, row(2).id, row(3).id]);
  newest = 3; await timer.tick();
  expect(controller.state().messages).toHaveLength(3);
  // Once the producer has observed the ACK, a later authoritative deletion wins.
  newest = 2; await timer.tick();
  expect(controller.state().messages).toHaveLength(2);
});

test("a failed read receipt is retried only by explicit recovery, even after rows are displayed", async () => {
  let newest = 2, acknowledgments = 0;
  stub(() => page(1, newest), (init) => {
    acknowledgments++;
    return acknowledgments === 2 ? Response.json({}, { status: 503 })
      : readAck(init);
  });
  const s = subject();
  await s.controller.open(contact);
  newest = 3; await s.timer.tick();
  expect(s.controller.state().messages).toHaveLength(3);
  expect(s.controller.state().error).not.toBe("");
  await s.timer.tick(); expect(acknowledgments).toBe(2);
  s.controller.foregroundChanged(); await Bun.sleep(0);
  expect(acknowledgments).toBe(3);
  expect(s.controller.state().error).toBe("");
});

test("a failed home refresh does not repeat an already committed read receipt", async () => {
  let newest = 2, acknowledgments = 0, homes = 0;
  stub(() => page(1, newest), (init) => {
    acknowledgments++;
    return readAck(init);
  });
  const timer = clock();
  const controller = createTalkController({
    observedMessageIds: () => controller.state().messages.map(message => message.id),
    session, receive: { isForeground: () => true, schedule: timer.schedule },
    refreshHome: async () => { if (++homes === 2) throw new Error("Home unavailable"); },
  });
  controllers.push(controller);
  await controller.open(contact);
  newest = 3; await timer.tick();
  expect(controller.state().error).not.toBe("");
  expect(acknowledgments).toBe(2);
  controller.foregroundChanged(); await Bun.sleep(0);
  expect(homes).toBe(3);
  expect(acknowledgments).toBe(2);
});

test("burst intervals remain visible on a bad before-page and are not retried automatically", async () => {
  let burst = false, gapReads = 0;
  stub(url => {
    if (url.searchParams.has("before")) { gapReads++; return page(56, 105, true); }
    return burst ? page(56, 105, true) : page(1, 5);
  });
  const { controller, timer } = subject();
  await controller.open(contact);
  burst = true; await timer.tick();
  await controller.loadGap(row(56).id);
  expect(controller.state().historyError).not.toBe("");
  expect(controller.state().gaps).toEqual([{ beforeId: row(56).id, canLoad: true }]);
  await timer.tick();
  expect(gapReads).toBe(1);
});

test("new unseen burst messages are not marked read until their interval has been checked", async () => {
  let burst = false, acknowledgments = 0;
  stub(url => {
    if (url.searchParams.has("before")) return page(1, 5);
    return burst ? page(56, 105, true) : page(1, 5);
  }, (init) => {
    acknowledgments++;
    return readAck(init);
  });
  const { controller, timer } = subject();
  await controller.open(contact);
  burst = true; await timer.tick();
  expect(acknowledgments).toBe(1);
  await controller.loadGap(row(56).id);
  expect(acknowledgments).toBe(1);
  await timer.tick();
  expect(acknowledgments).toBe(2);
});

test("community receive stays on its community message endpoint", async () => {
  let newest = 2;
  stub(url => {
    expect(url.pathname).toBe(`/api/communities/${encodeURIComponent(contact.ap_id)}/messages`);
    return page(1, newest);
  });
  const { controller, timer } = subject();
  await controller.open({ ...contact, type: "community" });
  newest = 3; await timer.tick();
  expect(controller.state().messages).toHaveLength(3);
});

test("incoming messages are not marked read while the user is reading older history", async () => {
  let newest = 2, acknowledgments = 0, atLatest = false;
  stub(() => page(1, newest), (init) => {
    acknowledgments++;
    return readAck(init);
  });
  const timer = clock();
  const controller = createTalkController({
    observedMessageIds: () => controller.state().messages.map(message => message.id),
    session, refreshHome: async () => {},
    receive: { isForeground: () => true, canMarkRead: () => atLatest, schedule: timer.schedule },
  });
  controllers.push(controller);
  await controller.open(contact);
  newest = 3; await timer.tick();
  expect(controller.state().messages).toHaveLength(3);
  expect(acknowledgments).toBe(0);
  atLatest = true;
  controller.readVisible(); await Bun.sleep(0);
  expect(acknowledgments).toBe(1);
});

test("an older interval accepts the producer's UTF-8 keyset ordering for non-ASCII AP IDs", async () => {
  const oldest = { ...row(1), id: session.hostUrl + "/ap/objects/A" };
  const middle = { ...row(2), id: session.hostUrl + "/ap/objects/\uE000" };
  const latest = { ...row(3), id: session.hostUrl + "/ap/objects/\u{10000}" };
  let burst = false;
  stub(url => url.searchParams.has("before")
    ? Response.json({ messages: [middle], has_more: true })
    : Response.json({ messages: burst ? [latest] : [oldest], has_more: burst }));
  const { controller, timer } = subject();
  await controller.open(contact);
  burst = true; await timer.tick();
  await controller.loadGap(latest.id);
  expect(controller.state().historyError).toBe("");
  expect(controller.state().messages.map(message => message.id)).toEqual([oldest.id, middle.id, latest.id]);
});
