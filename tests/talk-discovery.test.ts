import { afterEach, expect, test } from "bun:test";
import { searchTalkPeople } from "../src/api.ts";
import { createTalkDiscoveryController } from "../src/talk-discovery.ts";
import type { TalkContact } from "../src/talk-response.ts";

const session = { hostUrl: "https://talk.example", product: "yurume" as const,
  accessToken: "synthetic-account-A", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" };
const me = session.hostUrl + "/ap/users/me", buddy = session.hostUrl + "/ap/users/buddy";
const person = (ap_id = buddy) => ({ ap_id, preferred_username: "buddy", username: "buddy", name: "Buddy", icon_url: null });
const contact = (ap_id = buddy): TalkContact => ({ ap_id, preferred_username: "buddy", name: "Buddy", icon_url: null,
  type: "user", last_message: null, last_message_at: null, unread_count: 0 });
const page = (offset = 0, ids = [buddy], more = false) => Response.json({ actors: ids.map(id => person(id)), limit: 20, offset, has_more: more });
const originalFetch = globalThis.fetch;
const subjects: ReturnType<typeof createTalkDiscoveryController>[] = [];
afterEach(() => { subjects.splice(0).forEach(c => c.dispose()); globalThis.fetch = originalFetch; });
function subject(isActive = () => true) {
  const opened: TalkContact[] = [];
  const c = createTalkDiscoveryController({ session, actorApId: me, isActive, onOpen: value => opened.push(value) });
  subjects.push(c); c.show(); return { c, opened };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { resolve, promise };
}
function transport(handler?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const calls: Array<{ url: URL; method: string; signal: AbortSignal | undefined | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(session.hostUrl);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${session.accessToken}`);
    expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
    expect((init as { maxRedirections?: number }).maxRedirections).toBe(0);
    calls.push({ url, method: init?.method ?? "GET", signal: init?.signal });
    const found = handler?.(url, init); if (found) return found;
    if (url.pathname.startsWith("/api/search/")) return page(Number(url.searchParams.get("offset") ?? 0));
    if (url.pathname.startsWith("/api/dm/contact/")) return Response.json({ contact: contact() });
    throw new Error("Unexpected request " + url.pathname);
  }) as typeof fetch;
  return calls;
}

test("empty-home search offers a chosen canonical contact without following or sending", async () => {
  const calls = transport(url => url.pathname.startsWith("/api/search/") ? page(0, [me, buddy]) : undefined);
  const { c, opened } = subject();
  c.setQuery(" Buddy "); await c.search();
  expect(calls.map(x => x.url.pathname)).toEqual(["/api/search/actors"]);
  expect(calls[0]!.url.searchParams.toString()).toBe("q=Buddy&limit=20&offset=0");
  expect(c.state().people.map(x => x.ap_id)).toEqual([buddy]); expect(opened).toHaveLength(0);
  const copied = c.state().people[0]!; copied.ap_id = "forged";
  await c.openPerson("forged"); expect(calls).toHaveLength(1);
  await c.openPerson(buddy);
  expect(opened).toEqual([contact()]); expect(c.state().visible).toBe(false);
  expect(calls[1]!.url.pathname).toBe("/api/dm/contact/" + encodeURIComponent(buddy));
  expect(calls.every(x => x.method === "GET")).toBe(true);
});

test("remote handles are searched only through the selected host with an explicit choice", async () => {
  const remote = "https://other.example/users/real", calls = transport(url => {
    if (url.pathname === "/api/search/remote") return Response.json({ actors: [person(remote)] });
    if (url.pathname.startsWith("/api/dm/contact/")) return Response.json({ contact: contact(remote) });
  });
  const { c, opened } = subject(); c.setQuery("@buddy@other.example"); await c.search();
  expect(calls).toHaveLength(1); expect(calls[0]!.url.searchParams.toString()).toBe("q=%40buddy%40other.example");
  expect(opened).toHaveLength(0); expect(c.state().hasMore).toBe(false);
  await c.openPerson(remote); expect(opened[0]!.ap_id).toBe(remote);
  expect(calls.every(x => x.url.origin === session.hostUrl && x.method === "GET")).toBe(true);
});

test("edited search aborts the old read without unlocking or overwriting the new search", async () => {
  const first = deferred<Response>(), second = deferred<Response>();
  const calls = transport(url => url.searchParams.get("q") === "A" ? first.promise : second.promise);
  const { c } = subject(); c.setQuery("A"); const old = c.search();
  c.setQuery("B"); expect(calls[0]!.signal?.aborted).toBe(true); const current = c.search();
  first.resolve(page(0, ["https://old.example/user"])); await old;
  expect(c.state().loading).toBe(true); expect(c.state().people).toEqual([]); expect(c.state().error).toBe("");
  second.resolve(page()); await current;
  expect(c.state().query).toBe("B"); expect(c.state().people.map(x => x.ap_id)).toEqual([buddy]);
  expect(c.state().loading).toBe(false);
});

for (const boundary of ["close", "credential", "actor", "dispose", "inactive"] as const) {
  test(`a pending canonical contact cannot open after ${boundary}, including A→B→A`, async () => {
    const held = deferred<Response>(); let active = true;
    const calls = transport(url => url.pathname.startsWith("/api/dm/contact/") ? held.promise : undefined);
    const { c, opened } = subject(() => active); c.setQuery("Buddy"); await c.search();
    const pending = c.openPerson(buddy); await c.openPerson(buddy);
    expect(calls.filter(x => x.url.pathname.startsWith("/api/dm/contact/"))).toHaveLength(1);
    if (boundary === "close") { c.close(); c.show(); }
    if (boundary === "credential") { c.updateSession({ ...session, accessToken: "synthetic-B" }, me); c.updateSession(session, me); c.show(); }
    if (boundary === "actor") { c.updateSession(session, "other-actor"); c.updateSession(session, me); c.show(); }
    if (boundary === "dispose") c.dispose();
    if (boundary === "inactive") active = false;
    held.resolve(Response.json({ contact: contact() })); await pending;
    expect(opened).toHaveLength(0);
    if (boundary === "credential" || boundary === "actor") {
      expect(c.state().query).toBe(""); expect(c.state().people).toEqual([]);
    }
  });
}

test("changing the query cancels contact selection and an unselected ID cannot be opened", async () => {
  const held = deferred<Response>(), calls = transport(url => url.pathname.startsWith("/api/dm/contact/") ? held.promise : undefined);
  const { c, opened } = subject(); c.setQuery("Buddy"); await c.search();
  await c.openPerson("not-a-result"); expect(calls).toHaveLength(1);
  const open = c.openPerson(buddy); c.setQuery("new name");
  held.resolve(Response.json({ contact: contact() })); await open;
  expect(opened).toEqual([]); expect(c.state().people).toEqual([]); expect(c.state().query).toBe("new name");
});

test("more preserves results and retries a failed page at the original cursor", async () => {
  let fail = true;
  const calls = transport(url => {
    if (url.searchParams.get("offset") === "0") return page(0, [buddy], true);
    return fail ? Response.json({ error: "Unavailable" }, { status: 503 }) : page(20, [buddy, "https://talk.example/ap/users/second"]);
  });
  const { c } = subject(); c.setQuery("bud"); await c.search(); await c.more();
  expect(c.state().people.map(x => x.ap_id)).toEqual([buddy]); expect(c.state().error).not.toBe(""); expect(c.state().hasMore).toBe(true);
  fail = false; await c.more();
  expect(calls.map(x => x.url.searchParams.get("offset"))).toEqual(["0", "20", "20"]);
  expect(c.state().people.map(x => x.ap_id)).toEqual([buddy, "https://talk.example/ap/users/second"]);
  expect(c.state().error).toBe(""); expect(c.state().hasMore).toBe(false);
});

test("malformed or unauthorized search is an actionable failure, never an empty success", async () => {
  let payload: () => Response = () => Response.json({ actors: [] });
  const calls = transport(() => payload()), { c } = subject(); c.setQuery("Buddy");
  await c.search(); expect(c.state().searched).toBe(false); expect(c.state().error).not.toBe("");
  payload = () => Response.json({ error: "Unauthorized" }, { status: 401 });
  await c.search(); expect(c.state().searched).toBe(false); expect(c.state().error).not.toBe("");
  payload = () => page(); await c.search();
  expect(c.state().error).toBe(""); expect(c.state().searched).toBe(true); expect(calls).toHaveLength(3);
});

test("a mismatched or rejected canonical contact is not selected and can be retried explicitly", async () => {
  let deny = true;
  const calls = transport(url => url.pathname.startsWith("/api/dm/contact/")
    ? Response.json({ contact: contact(deny ? "wrong-recipient" : buddy) }) : undefined);
  const { c, opened } = subject(); c.setQuery("Buddy"); await c.search(); await c.openPerson(buddy);
  expect(c.state().visible).toBe(true); expect(c.state().error).not.toBe(""); expect(opened).toEqual([]);
  deny = false; await c.openPerson(buddy); expect(opened).toEqual([contact()]);
  expect(calls).toHaveLength(3);
});

test("background suspension settles local state and ignores a late result until explicit retry", async () => {
  const held = deferred<Response>(); let hold = true;
  transport(() => hold ? held.promise : page()); const { c } = subject(); c.setQuery("Buddy");
  const pending = c.search(); c.suspend(); expect(c.state().loading).toBe(false); expect(c.state().error).not.toBe("");
  held.resolve(page()); await pending; expect(c.state().people).toEqual([]);
  hold = false; await c.search(); expect(c.state().people.map(x => x.ap_id)).toEqual([buddy]);
});

test("bad queries and invalid page positions perform zero HTTP requests", async () => {
  const calls = transport();
  for (const query of ["", " ", "x".repeat(257), "@bad@host@other", "@bad@host/path", "bad\nname"]) {
    await expect(searchTalkPeople(session, query)).rejects.toThrow();
  }
  for (const offset of [-20, 1, 10_020, NaN]) await expect(searchTalkPeople(session, "Buddy", offset)).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test("a different page or missing continuation is not adopted as the requested page", async () => {
  const calls = transport(() => page(20));
  await expect(searchTalkPeople(session, "Buddy")).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
