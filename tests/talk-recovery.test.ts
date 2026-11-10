import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createTalkRecoveryStore, type TalkRecoveryDraft } from "../src/talk-recovery.ts";
import { talkUploadResponse } from "../src/talk-attachments.ts";

function secureStore() {
  const values = new Map<string, string>();
  return {
    kind: "secure" as const,
    async get(key: string) { return values.get(key); },
    async set(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  } satisfies MobileSecureStore;
}

const scope = { product: "yurume" as const, hostUrl: "https://recovery.example", actorApId: "https://recovery.example/users/me" };
const draft: TalkRecoveryDraft = {
  contact: { type: "user", apId: "https://recovery.example/users/buddy" },
  content: "未送信の日本語本文", sendState: "draft", attachments: [],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("a new recovery handle restores the same account's Japanese draft", async () => {
  const store = secureStore(), first = createTalkRecoveryStore({ store, scope });
  await first.save([draft]);
  const restored = await createTalkRecoveryStore({ store, scope }).load();
  expect(restored).toEqual([{
    contact: { type: "user", apId: "https://recovery.example/users/buddy" },
    content: "未送信の日本語本文", sendState: "draft", attachments: [],
  }]);
});

test("private message recovery refuses missing, memory and plaintext stores", () => {
  for (const store of [undefined, { ...secureStore(), kind: "memory" }, { ...secureStore(), kind: "browser-local" }]) {
    expect(() => createTalkRecoveryStore({ store: store as MobileSecureStore, scope })).toThrow(/secure/i);
  }
});

test("recovery uses the canonical host while keeping actor and API scopes separate", async () => {
  const store = secureStore();
  await createTalkRecoveryStore({ store, scope: { ...scope, hostUrl: "https://RECOVERY.example:443/" } }).save([draft]);
  expect(await createTalkRecoveryStore({ store, scope }).load()).toEqual([draft]);
  for (const changed of [
    { ...scope, hostUrl: "https://other.example" },
    { ...scope, actorApId: "https://recovery.example/users/other" },
    { ...scope, apiBaseUrl: "https://recovery.example/another-api" },
  ]) expect(await createTalkRecoveryStore({ store, scope: changed }).load()).toBeNull();
});

test("unverified scopes cannot enter private recovery storage", () => {
  for (const invalid of [
    { ...scope, product: "yurucommu" },
    { ...scope, actorApId: "actor\nother" },
    { ...scope, hostUrl: "https://recovery.example/?token=synthetic-never-persist" },
    { ...scope, apiBaseUrl: "https://other.example/api" },
    { ...scope, accessToken: "synthetic-never-persist" },
  ]) expect(() => createTalkRecoveryStore({ store: secureStore(), scope: invalid as unknown as typeof scope })).toThrow(/scope/i);
});

test("unverified draft payloads cannot replace saved private work", async () => {
  const recovery = createTalkRecoveryStore({ store: secureStore(), scope });
  await recovery.save([draft]);
  for (const invalid of [
    [{ ...draft, accessToken: "synthetic-never-persist" }],
    [{ ...draft, content: "x".repeat(2001) }],
    [{ ...draft, sendState: "confirmed" }],
    [{ ...draft, contact: { type: "user", apId: "bad\nrecipient" } }],
    [{ ...draft, content: "   " }],
    [draft, draft],
  ]) {
    await expect(recovery.save(invalid as readonly TalkRecoveryDraft[])).rejects.toThrow(/recovery data/i);
    expect(await recovery.load()).toEqual([draft]);
  }
});

test("corrupt or unsupported snapshots are reported without erasing the stored bytes", async () => {
  let mutations = 0;
  for (const raw of ["not-json", "", "null", "[]", JSON.stringify({ version: 2, drafts: [] }),
    JSON.stringify({ version: 1, drafts: [draft], accessToken: "synthetic-private" })]) {
    const store: MobileSecureStore = {
      kind: "secure", async get() { return raw; },
      async set() { mutations++; }, async delete() { mutations++; },
    };
    await expect(createTalkRecoveryStore({ store, scope }).load()).rejects.toThrow(/recovery data/i);
    expect(await store.get("unchanged")).toBe(raw);
  }
  expect(mutations).toBe(0);
});

test("bounded recovery rejects excess conversations and oversized UTF-8 snapshots", async () => {
  const base = secureStore();
  let captured = "", override: string | undefined;
  const store: MobileSecureStore = { ...base,
    async get(key) { return override ?? base.get(key); },
    async set(key, value) { captured = value; await base.set(key, value); },
  };
  const recovery = createTalkRecoveryStore({ store, scope });
  await recovery.save([draft]);
  const valid = captured;
  const many = Array.from({ length: 101 }, (_, n) => ({ ...draft, contact: { ...draft.contact, apId: "person-" + n } }));
  await expect(recovery.save(many)).rejects.toThrow(/recovery data/i);
  const large = Array.from({ length: 100 }, (_, n) => ({ ...draft, content: "文".repeat(2000),
    contact: { type: "user" as const, apId: "人".repeat(1996) + String(n).padStart(4, "0") } }));
  await expect(recovery.save(large)).rejects.toThrow(/recovery data/i);
  expect(await recovery.load()).toEqual([draft]);
  override = JSON.stringify({ ...JSON.parse(valid), drafts: large });
  await expect(recovery.load()).rejects.toThrow(/recovery data/i);
});

test("an expired recovery snapshot requires manual review without erasing uncertain intent", async () => {
  const base = secureStore();
  let key = "", raw = "", clock = Date.UTC(2026, 10, 10);
  const store: MobileSecureStore = { ...base, async set(k, v) { key = k; raw = v; await base.set(k, v); } };
  const recovery = createTalkRecoveryStore({ store, scope, now: () => clock });
  await recovery.save([{ ...draft, sendState: "uncertain" }]);
  clock += 7 * 86400_000 - 1;
  expect((await recovery.load())?.[0].sendState).toBe("uncertain");
  clock++;
  await expect(recovery.load()).rejects.toMatchObject({ code: "expired" });
  expect(await store.get(key)).toBe(raw);
});

test("a delayed older write cannot overwrite a newer draft from another handle", async () => {
  const base = secureStore(), entered = deferred(), release = deferred();
  let firstWrite = true;
  const store: MobileSecureStore = { ...base, async set(key, value) {
    if (firstWrite) { firstWrite = false; entered.resolve(); await release.promise; }
    await base.set(key, value);
  } };
  const first = createTalkRecoveryStore({ store, scope }), second = createTalkRecoveryStore({ store, scope });
  await second.load();
  const older = first.save([{ ...draft, content: "古い編集" }]);
  await entered.promise;
  const newer = second.save([{ ...draft, content: "新しい編集" }]);
  // The warmed second handle can reach its public storage port on the next microtask.
  await Promise.resolve(); await Promise.resolve();
  release.resolve();
  await Promise.all([older, newer]);
  expect((await second.load())?.[0].content).toBe("新しい編集");
});

test("retiring a scope clears its record and fences old handles without deleting a new generation", async () => {
  const store = secureStore(), old = createTalkRecoveryStore({ store, scope });
  await old.save([draft]);
  await old.retire();
  await expect(old.load()).rejects.toMatchObject({ code: "retired" });
  await expect(old.save([draft])).rejects.toMatchObject({ code: "retired" });
  const fresh = createTalkRecoveryStore({ store, scope });
  expect(await fresh.load()).toBeNull();
  await fresh.save([{ ...draft, content: "再ログイン後の下書き" }]);
  await old.retire();
  expect((await fresh.load())?.[0].content).toBe("再ログイン後の下書き");
});

test("retirement fences in-flight and queued A writes while preserving B", async () => {
  const base = secureStore(), entered = deferred(), release = deferred();
  let hold = false;
  const written: string[] = [];
  const store: MobileSecureStore = { ...base, async set(key, value) {
    if (hold) { hold = false; entered.resolve(); await release.promise; }
    written.push(JSON.parse(value).drafts[0]?.content);
    await base.set(key, value);
  } };
  const a = createTalkRecoveryStore({ store, scope }), sibling = createTalkRecoveryStore({ store, scope });
  const b = createTalkRecoveryStore({ store, scope: { ...scope, actorApId: "other-actor" } });
  await b.save([{ ...draft, content: "Bの下書き" }]);
  hold = true;
  const pending = a.save([{ ...draft, content: "A書込中" }]).catch(error => error);
  await entered.promise;
  const queued = sibling.save([{ ...draft, content: "A待機中" }]).catch(error => error);
  const retired = a.retire();
  try { await expect(sibling.save([draft])).rejects.toMatchObject({ code: "retired" }); }
  finally { release.resolve(); }
  const [first, second] = await Promise.all([pending, queued, retired]);
  expect(first).toMatchObject({ code: "retired" });
  expect(second).toMatchObject({ code: "retired" });
  expect(written).not.toContain("A待機中");
  expect((await b.load())?.[0].content).toBe("Bの下書き");
  expect(await createTalkRecoveryStore({ store, scope }).load()).toBeNull();
});

test("retirement rejects an old load whose private bytes arrive late", async () => {
  const base = secureStore(), entered = deferred(), release = deferred();
  let hold = false;
  const store: MobileSecureStore = { ...base, async get(key) {
    const value = await base.get(key);
    if (hold) { hold = false; entered.resolve(); await release.promise; }
    return value;
  } };
  const recovery = createTalkRecoveryStore({ store, scope });
  await recovery.save([draft]);
  hold = true;
  const loading = recovery.load().catch(error => error);
  await entered.promise;
  const retired = recovery.retire();
  release.resolve();
  const [result] = await Promise.all([loading, retired]);
  expect(result).toMatchObject({ code: "retired" });
  expect(await createTalkRecoveryStore({ store, scope }).load()).toBeNull();
});

test("storage read and write failures keep their cause without poisoning later explicit work", async () => {
  for (const operation of ["get", "set"] as const) {
    const base = secureStore(), failure = new Error("synthetic private-store I/O failure");
    let fail = true;
    const store: MobileSecureStore = { ...base,
      async get(key) { if (operation === "get" && fail) { fail = false; throw failure; } return base.get(key); },
      async set(key, value) { if (operation === "set" && fail) { fail = false; throw failure; } await base.set(key, value); },
    };
    const recovery = createTalkRecoveryStore({ store, scope });
    await expect(operation === "get" ? recovery.load() : recovery.save([draft])).rejects.toMatchObject({ code: "storage", cause: failure });
    await recovery.save([draft]);
    expect(await recovery.load()).toEqual([draft]);
  }
});

test("a failed purge stays fenced and can be explicitly retried from a replacement handle", async () => {
  const base = secureStore(), failure = new Error("synthetic purge failure");
  let fail = true;
  const store: MobileSecureStore = { ...base, async delete(key) {
    if (fail) { fail = false; throw failure; }
    await base.delete(key);
  } };
  const old = createTalkRecoveryStore({ store, scope });
  await old.save([draft]);
  await expect(old.retire()).rejects.toMatchObject({ code: "storage", cause: failure });
  const replacement = createTalkRecoveryStore({ store, scope });
  await expect(replacement.load()).rejects.toMatchObject({ code: "retired" });
  await expect(replacement.save([draft])).rejects.toMatchObject({ code: "retired" });
  await replacement.retire();
  expect(await createTalkRecoveryStore({ store, scope }).load()).toBeNull();
});

test("media-only pending intent restores canonical references and marks expired or unfinished files for reselection", async () => {
  let clock = Date.now();
  const recovery = createTalkRecoveryStore({ store: secureStore(), scope, now: () => clock });
  const upload = { attachment: { type: "Document" as const, mediaType: "image/png", url: "/media/a1.png",
    r2_key: "uploads/a1.png", name: "写真.png" }, expiresAt: new Date(clock + 60_000).toISOString() };
  await recovery.save([{ ...draft, content: "", sendState: "pending", attachments: [
    { phase: "ready", upload },
    { phase: "needs-reselection", name: "動画.mp4", mediaType: "video/mp4", size: 123, reason: "unknown" },
  ] }]);
  expect((await recovery.load())?.[0]).toEqual({ ...draft, content: "", sendState: "pending", attachments: [
    { phase: "ready", upload },
    { phase: "needs-reselection", name: "動画.mp4", mediaType: "video/mp4", size: 123, reason: "unknown" },
  ] });
  clock += 60_000;
  expect((await recovery.load())?.[0]).toEqual({ ...draft, content: "", sendState: "pending", attachments: [
    { phase: "needs-reselection", name: "写真.png", mediaType: "image/png", reason: "expired" },
    { phase: "needs-reselection", name: "動画.mp4", mediaType: "video/mp4", size: 123, reason: "unknown" },
  ] });
});

test("unverified media cannot replace a valid recovery snapshot", async () => {
  const recovery = createTalkRecoveryStore({ store: secureStore(), scope });
  await recovery.save([draft]);
  const upload = { attachment: { type: "Document" as const, mediaType: "image/png", url: "/media/a1.png",
    r2_key: "uploads/a1.png", name: "写真.png" }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const ready = { phase: "ready", upload };
  for (const attachments of [
    Array(1),
    [{ ...ready, upload: { ...upload, attachment: { ...upload.attachment, url: "https://other.example/media/a1.png" } } }],
    [{ ...ready, upload: { ...upload, attachment: { ...upload.attachment, r2_key: "other/a1.png" } } }],
    [{ ...ready, upload: { ...upload, attachment: { ...upload.attachment, mediaType: "__proto__" } } }],
    [{ ...ready, file: new File(["x"], "private.png") }],
    Array.from({ length: 9 }, () => ready),
  ]) {
    await expect(recovery.save([{ ...draft, attachments } as TalkRecoveryDraft])).rejects.toMatchObject({ code: "invalid-data" });
    expect(await recovery.load()).toEqual([draft]);
  }
});

test("recovery's structural decoder does not relax the live upload freshness gate", () => {
  const decoder = talkUploadResponse(new File(["x"], "photo.png", { type: "image/png" }));
  expect(() => decoder.decode({ id: "a1", content_type: "image/png", url: "/media/a1.png",
    r2_key: "uploads/a1.png", expires_at: new Date(Date.now() - 1).toISOString() })).toThrow(/canonical media reference/);
});

test("a valid snapshot presented under another actor is rejected without deleting original work", async () => {
  const base = secureStore();
  let captured = "", transplant = false;
  const store: MobileSecureStore = { ...base,
    async get(key) { return transplant ? captured : base.get(key); },
    async set(key, value) { captured = value; await base.set(key, value); },
  };
  const original = createTalkRecoveryStore({ store, scope });
  await original.save([draft]);
  transplant = true;
  const other = createTalkRecoveryStore({ store, scope: { ...scope, actorApId: "different-actor" } });
  await expect(other.load()).rejects.toMatchObject({ code: "invalid-data" });
  transplant = false;
  expect(await original.load()).toEqual([draft]);
});

test("queued recovery captures the accepted draft instead of later object mutations", async () => {
  const base = secureStore(), entered = deferred(), release = deferred();
  let hold = true;
  const store: MobileSecureStore = { ...base, async set(key, value) {
    if (hold) { hold = false; entered.resolve(); await release.promise; }
    await base.set(key, value);
  } };
  const busy = createTalkRecoveryStore({ store, scope: { ...scope, actorApId: "busy-actor" } }).save([draft]);
  await entered.promise;
  const recovery = createTalkRecoveryStore({ store, scope });
  const editable = { ...draft, contact: { ...draft.contact } };
  const saving = recovery.save([editable]);
  editable.content = "後から変更";
  editable.contact.apId = "later-recipient";
  release.resolve();
  await Promise.all([busy, saving]);
  expect(await recovery.load()).toEqual([draft]);
});

test("a queued snapshot which expires before its write is not persisted", async () => {
  const base = secureStore(), entered = deferred(), release = deferred();
  let clock = Date.now(), hold = true;
  const store: MobileSecureStore = { ...base, async set(key, value) {
    if (hold) { hold = false; entered.resolve(); await release.promise; }
    await base.set(key, value);
  } };
  const busy = createTalkRecoveryStore({ store, scope: { ...scope, actorApId: "busy-actor" } }).save([draft]);
  await entered.promise;
  const recovery = createTalkRecoveryStore({ store, scope, now: () => clock });
  const saving = recovery.save([draft]).catch(error => error);
  clock += 7 * 86400_000;
  release.resolve();
  const [, failure] = await Promise.all([busy, saving]);
  expect(failure).toMatchObject({ code: "expired" });
  expect(await recovery.load()).toBeNull();
});
