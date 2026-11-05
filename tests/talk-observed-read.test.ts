import { afterEach, expect, test } from "bun:test";
import { initializeObservedTalkRead, acknowledgeObservedTalkMessages } from "../src/api.ts";
import type { MobileSession } from "@takosjp/mobile-kit";
import { createTalkController } from "../src/talk-controller.ts";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const contact = { type: "user" as const, ap_id: "https://peer.example/users/buddy" };
const session = (): MobileSession => ({ product: "yurume", hostUrl: "https://observed.example", accessToken: "synthetic-local", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" });

test("observed read init requires the explicit versioned contract and never uses legacy /read", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    expect(init?.method).toBe("POST");
    return Response.json({ success: true, read_observed: { version: 1, max_ids: 50 } });
  }) as unknown as typeof fetch;
  await initializeObservedTalkRead(session(), contact);
  expect(paths).toEqual([`/api/dm/user/${encodeURIComponent(contact.ap_id)}/read-observed/init`]);
  globalThis.fetch = (async () => Response.json({ success: true, last_read_at: "now" })) as unknown as typeof fetch;
  await expect(initializeObservedTalkRead(session(), contact)).rejects.toMatchObject({ name: "YurumeetResponseError" });
});

test("ACK submits exact IDs in bounded bodies and captures one host/identity for all chunks", async () => {
  const selected = { ...session() };
  const bodies: string[][] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://observed.example");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-local");
    expect(url.pathname.endsWith("/read-observed")).toBe(true);
    const { message_ids } = JSON.parse(String(init?.body)) as { message_ids: string[] };
    bodies.push(message_ids);
    expect(message_ids.length).toBeLessThanOrEqual(50);
    expect(new TextEncoder().encode(String(init?.body)).length).toBeLessThanOrEqual(32768);
    selected.hostUrl = "https://changed.example"; selected.accessToken = "changed";
    return Response.json({ success: true, message_ids });
  }) as unknown as typeof fetch;
  const ids = Array.from({ length: 101 }, (_, i) => `https://ids.example/${i}`);
  await acknowledgeObservedTalkMessages(selected, contact, ids);
  expect(bodies.map((body) => body.length)).toEqual([50, 50, 1]);
  expect(bodies.flat()).toEqual(ids);
});

test("invalid or ambiguous ACK never continues to another chunk or silently uses a timestamp receipt", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ success: true, message_ids: ["not-requested"] }); }) as unknown as typeof fetch;
  await expect(acknowledgeObservedTalkMessages(session(), contact, Array.from({ length: 51 }, (_, i) => String(i)))).rejects.toMatchObject({ name: "YurumeetResponseError" });
  expect(calls).toBe(1);
  globalThis.fetch = (async () => { calls++; return new Response("unsupported", { status: 404 }); }) as unknown as typeof fetch;
  await expect(initializeObservedTalkRead(session(), contact)).rejects.toMatchObject({ status: 404 });
  expect(calls).toBe(2);
});

test("body byte bound handles long Unicode IDs and an aborted operation sends no later ACK", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `${i}-${"界".repeat(500)}`);
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(new TextEncoder().encode(String(init?.body)).length).toBeLessThanOrEqual(32768);
    return Response.json({ success: true, message_ids: JSON.parse(String(init?.body)).message_ids });
  }) as unknown as typeof fetch;
  await acknowledgeObservedTalkMessages(session(), contact, ids);
  expect(calls).toBe(2);
  const abort = new AbortController(); abort.abort(new Error("own request cancelled"));
  await expect(acknowledgeObservedTalkMessages(session(), contact, ["one"], abort.signal)).rejects.toThrow("own request cancelled");
  expect(calls).toBe(2);
});

test("controller initializes before GET, renders before ACK, and acknowledges only current visible IDs", async () => {
  const order: string[] = [], acknowledgments: string[][] = [];
  let visible = ["a"], loading = true;
  const rows = ["a", "b"].map(id => ({ id, content: id, created_at: "2026-11-05T00:00:00Z", sender: { ap_id: contact.ap_id, preferred_username: "peer", name: null } }));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/read-observed/init")) { order.push("init"); return Response.json({ success: true, read_observed: { version: 1, max_ids: 50 } }); }
    if (path.endsWith("/messages")) { order.push("GET"); return Response.json({ messages: rows, has_more: false }); }
    expect(path.endsWith("/read-observed")).toBe(true);
    expect(loading).toBe(false);
    order.push("ACK");
    const { message_ids } = JSON.parse(String(init?.body)) as { message_ids: string[] };
    acknowledgments.push(message_ids);
    return Response.json({ success: true, message_ids });
  }) as unknown as typeof fetch;
  const controller = createTalkController({ session: session(), observedMessageIds: () => visible, refreshHome: async () => {}, onChange: next => { loading = next.loading; }, receive: { isForeground: () => true, schedule: () => () => {} } });
  try {
    await controller.open({ ...contact, preferred_username: "peer", name: null, icon_url: null, last_message: null, last_message_at: null, unread_count: 0 });
    expect(order).toEqual(["init", "GET", "ACK"]);
    expect(acknowledgments).toEqual([["a"]]);
    visible = ["b", "unknown DOM row"];
    controller.readVisible(); await Bun.sleep(0);
    expect(acknowledgments).toEqual([["a"], ["b"]]);
    controller.readVisible(); await Bun.sleep(0);
    expect(acknowledgments).toHaveLength(2);
    expect(order.filter(entry => entry === "GET")).toHaveLength(1);
  } finally { controller.dispose(); }
});

test("unsupported exact init preserves the draft and never fetches or silently acknowledges a legacy page", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => { paths.push(new URL(String(input)).pathname); return new Response("unsupported", { status: 404 }); }) as unknown as typeof fetch;
  const controller = createTalkController({ session: session(), observedMessageIds: () => [], refreshHome: async () => {} });
  try {
    const opening = controller.open({ ...contact, preferred_username: "peer", name: null, icon_url: null, last_message: null, last_message_at: null, unread_count: 0 });
    controller.setDraft("retain input");
    await opening;
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith("/read-observed/init")).toBe(true);
    expect(controller.state()).toMatchObject({ loading: false, messages: [], content: "retain input" });
    expect(controller.state().error).not.toBe("");
  } finally { controller.dispose(); }
});

test("an untyped caller that omits observed IDs cannot turn fetched rows into an ACK", async () => {
  let acknowledgments = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/init")) return Response.json({ success: true, read_observed: { version: 1, max_ids: 50 } });
    if (path.endsWith("/messages")) return Response.json({ messages: [{ id: "unobserved", content: "not seen", created_at: null, sender: { ap_id: contact.ap_id, preferred_username: "peer", name: null } }], has_more: false });
    acknowledgments++;
    return Response.json({ success: true, message_ids: JSON.parse(String(init?.body)).message_ids });
  }) as unknown as typeof fetch;
  const options = { session: session(), refreshHome: async () => {}, observedMessageIds: () => [] as readonly string[] };
  // JavaScript callers can violate the TypeScript-required property.
  Reflect.deleteProperty(options, "observedMessageIds");
  const controller = createTalkController(options);
  try {
    await controller.open({ ...contact, preferred_username: "peer", name: null, icon_url: null, last_message: null, last_message_at: null, unread_count: 0 });
    expect(acknowledgments).toBe(0);
    expect(controller.state().messages).toHaveLength(1);
    expect(controller.state().error).not.toBe("");
  } finally { controller.dispose(); }
});
