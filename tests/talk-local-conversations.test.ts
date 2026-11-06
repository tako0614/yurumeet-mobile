import { afterEach, expect, test } from "bun:test";
import { createTalkController } from "../src/talk-controller.ts";
import type { TalkContact } from "../src/api.ts";
import { observedInitAck, observedMessageAck } from "./talk-read-fixture.ts";

const session = { hostUrl: "https://talk.example", product: "yurume" as const,
  accessToken: "synthetic-local-draft", tokenType: "Bearer", createdAt: "2026-11-06T00:00:00Z" };
const me = session.hostUrl + "/ap/users/me";
const buddy: TalkContact = { type: "user", ap_id: session.hostUrl + "/ap/users/buddy", preferred_username: "buddy",
  name: "Buddy", icon_url: null, last_message: null, last_message_at: null, unread_count: 0 };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { resolve, promise };
}
function subject(input: { post?: () => Promise<Response>; refreshHome?: () => Promise<void>; failReads?: () => boolean;
  messages?: () => Response; readAck?: (init?: RequestInit) => Promise<Response> } = {}) {
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? "GET";
    calls.push({ path, method });
    if (input.failReads?.() && (method === "GET" || path.endsWith("/read-observed/init"))) return Response.json({ error: "Read unavailable" }, { status: 503 });
    if (path.endsWith("/read-observed/init")) return observedInitAck();
    if (path.endsWith("/read-observed")) return input.readAck ? input.readAck(init) : observedMessageAck(init);
    if (path === "/api/media/upload") return Response.json({ error: "Upload unavailable" }, { status: 503 });
    if (method === "POST" && path.endsWith("/messages") && input.post) return input.post();
    return input.messages ? input.messages() : Response.json({ messages: [] });
  }) as typeof fetch;
  const c = createTalkController({ session, actorApId: me, refreshHome: input.refreshHome ?? (async () => {}),
    observedMessageIds: () => c.state().messages.map(item => item.id) });
  return { c, calls };
}

test("a retained draft exposes its canonical contact after Back without retaining merely visited rows", async () => {
  const { c } = subject();
  try {
    await c.open(buddy); c.back();
    expect(c.state().retainedContacts).toEqual([]);
    await c.open(buddy); c.setDraft("Local draft"); c.back();
    expect(c.state().retainedContacts).toEqual([buddy]);
    c.state().retainedContacts[0]!.ap_id = "changed snapshot";
    expect(c.state().retainedContacts[0]!.ap_id).toBe(buddy.ap_id);
    await c.open(buddy); c.setDraft(""); c.back();
    expect(c.state().retainedContacts).toEqual([]);
  } finally { c.dispose(); }
});

test("a confirmed local route stays reachable when Back cancels a reopened page's observed-read ACK", async () => {
  const held = deferred<Response>(), entered = deferred<void>();
  let known = false, readInit: RequestInit | undefined, reopening: Promise<void> | undefined;
  const message = { id: "held-read-first", content: "Accepted first", created_at: "2026-11-06T00:00:00Z",
    sender: { ap_id: me, preferred_username: "me", name: "Me" } };
  const { c } = subject({ post: async () => { known = true; return Response.json({ message }); },
    messages: () => Response.json({ messages: known ? [message] : [] }),
    readAck: async init => { readInit = init; entered.resolve(); return held.promise; },
  });
  try {
    await c.open(buddy); c.setDraft("Accepted first"); await c.send(); c.back();
    expect(c.state().retainedContacts).toEqual([buddy]);
    reopening = c.open(c.state().retainedContacts[0]!);
    await entered.promise;
    c.back();
    expect(c.state().retainedContacts).toEqual([buddy]);
  } finally {
    held.resolve(readInit ? observedMessageAck(readInit) : Response.json({ success: true, message_ids: [] }));
    await reopening; c.dispose();
  }
});

test("a first accepted send and newer draft remain reachable when home readback fails after Back", async () => {
  const post = deferred<Response>(); let refreshes = 0;
  const { c, calls } = subject({ post: () => post.promise, refreshHome: async () => { if (++refreshes > 1) throw Error("Home unavailable"); } });
  const ack = () => Response.json({ message: { id: "accepted", content: "Submitted draft", created_at: "2026-11-06T00:00:00Z",
    sender: { ap_id: me, preferred_username: "me", name: "Me" } } });
  let sending: Promise<void> | undefined;
  try {
    await c.open(buddy); c.setDraft("Submitted draft"); sending = c.send();
    c.setDraft("Newer retained draft"); c.back();
    expect(c.state().retainedContacts).toEqual([buddy]);
    post.resolve(ack()); await sending;
    expect(c.state().retainedContacts).toEqual([buddy]);
    await c.open(c.state().retainedContacts[0]!);
    expect(c.state().content).toBe("Newer retained draft");
    expect(calls.filter(item => item.method === "POST" && item.path.endsWith("/messages"))).toHaveLength(1);
  } finally { post.resolve(ack()); await sending; c.dispose(); }
});

test("an unknown send stays reachable after its text is cleared and never resends automatically", async () => {
  const { c, calls } = subject({ post: async () => Response.json({ error: "Unavailable" }, { status: 503 }) });
  try {
    await c.open(buddy); c.setDraft("Maybe delivered"); await c.send();
    c.setDraft(""); c.back();
    expect(c.state().retainedContacts).toEqual([buddy]);
    await c.open(c.state().retainedContacts[0]!);
    expect(c.state().content).toBe("");
    expect(calls.filter(item => item.method === "POST" && item.path.endsWith("/messages"))).toHaveLength(1);
  } finally { c.dispose(); }
});

test("a failed attachment-only draft remains reachable after Back", async () => {
  const { c } = subject();
  try {
    await c.open(buddy);
    expect(c.captureAttachmentSelection()([new File([new Uint8Array([137,80,78,71])], "fixture.png", { type: "image/png" })])).toBe(true);
    const end = Date.now() + 1000;
    while (c.state().attachments.some(item => item.phase === "uploading" || item.phase === "queued") && Date.now() < end) await Bun.sleep(0);
    expect(c.state().attachments).toHaveLength(1);
    c.back();
    expect(c.state().retainedContacts).toEqual([buddy]);
    await c.open(c.state().retainedContacts[0]!);
    expect(c.state().attachments).toHaveLength(1);
  } finally { c.dispose(); }
});

test("a local send route survives failed and successful empty reads without retaining stale message data", async () => {
  let failReads = false, refreshes = 0;
  const { c, calls } = subject({ failReads: () => failReads,
    refreshHome: async () => { if (++refreshes > 1) throw Error("Home unavailable"); },
    post: async () => Response.json({ message: { id: "confirmed-first", content: "First message", created_at: "2026-11-06T00:00:00Z",
      sender: { ap_id: me, preferred_username: "me", name: "Me" } } }),
  });
  try {
    await c.open(buddy); c.setDraft("First message"); await c.send(); c.back();
    expect(c.state().retainedContacts).toEqual([buddy]);
    failReads = true;
    await c.open(c.state().retainedContacts[0]!); c.back();
    expect(c.state().retainedContacts).toEqual([buddy]);
    failReads = false;
    await c.open(c.state().retainedContacts[0]!); c.back();
    expect(c.state().messages).toEqual([]);
    expect(c.state().retainedContacts).toEqual([buddy]);
    expect(calls.filter(item => item.method === "POST" && item.path.endsWith("/messages"))).toHaveLength(1);
  } finally { c.dispose(); expect(c.state().retainedContacts).toEqual([]); }
});

for (const boundary of ["credential", "actor", "API root", "dispose"] as const) {
  test(`retained conversation routes retire on ${boundary}`, async () => {
    const { c } = subject();
    try {
      await c.open(buddy); c.setDraft("Private draft"); c.back();
      expect(c.state().retainedContacts).toHaveLength(1);
      if (boundary === "credential") c.updateSession({ ...session, accessToken: "next-synthetic-session" });
      if (boundary === "API root") c.updateSession({ ...session, apiBaseUrl: session.hostUrl + "/other-api" });
      if (boundary === "actor") c.updateActor(session.hostUrl + "/ap/users/another");
      if (boundary === "dispose") c.dispose();
      expect(c.state().retainedContacts).toEqual([]);
    } finally { c.dispose(); }
  });
}
