import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import {
  createMobileClientController,
  createTauriMobileDefaultProductBridge,
  loadMobileAccounts,
  mobileAccountSessionStorageKey,
  saveMobileAccountSession,
  type MobileSession,
  type NativeBridge,
  type TauriStoreHandle,
} from "@takosjp/mobile-kit";
import { createTalkRecoveryAccounts } from "../src/talk-recovery-account.ts";
import { createTalkController } from "../src/talk-controller.ts";
import { productAdapter } from "../src/product.ts";
import { observedInitAck } from "./talk-read-fixture.ts";

type ProductApp = ReturnType<
  typeof import("../src/mobile-app.tsx").createYurumeetMobileApp
>;
let server: ViteDevServer;
let scratch: string;
let createApp: (bridge: () => NativeBridge) => ProductApp;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "yurumeet-kit-adoption-"));
  server = await createServer({
    configFile: false,
    root: new URL("..", import.meta.url).pathname,
    cacheDir: scratch,
    plugins: [solid({ ssr: true })],
    server: { middlewareMode: true, watch: null, hmr: false },
    ssr: { noExternal: ["@takosjp/mobile-kit"] },
  });
  // The owning JSX compiler loads the actual product cleanup closure. This
  // does not render a device UI or replace its account-retirement callback.
  createApp = (await server.ssrLoadModule("/src/mobile-app.tsx")).createYurumeetMobileApp;
});
afterAll(async () => {
  await server?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function fixture() {
  let sends = 0, unlocks = 0, refuseCleanup = false;
  const plain = new Map<string, string>(), secure = new Map<string, string>();
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/read-observed/init")) return observedInitAck();
    if (path.endsWith("/messages") && request.method === "GET") {
      return Response.json({ messages: [], has_more: false });
    }
    if (path.endsWith("/messages") && request.method === "POST") {
      sends++;
      return new Response("synthetic unknown send outcome", { status: 503 });
    }
    throw new Error("unexpected local talk fixture route");
  } });
  const bridge: NativeBridge = {
    capabilities: {
      launchPayload: true, launchPayloadEvents: false, externalBrowser: false,
      inAppBrowser: false, qrScanner: false, localNotifications: false,
      pushNotifications: false, biometricAuth: true, callIntent: false,
      clipboardText: false, secureStorage: true, persistentStorage: true,
    },
    storage: {
      kind: "device-persistent",
      get: async (key) => plain.get(key),
      set: async (key, value) => { plain.set(key, value); },
      delete: async (key) => { plain.delete(key); },
    },
    secureStore: {
      kind: "secure",
      get: async (key) => secure.get(key),
      set: async (key, value) => { secure.set(key, value); },
      delete: async (key) => {
        if (refuseCleanup && key.startsWith("yurumeet:talk-recovery-account:v1:")) {
          throw new Error("synthetic talk envelope delete refusal");
        }
        secure.delete(key);
      },
    },
    getLaunchPayload: async () => undefined,
    openExternalUrl: async () => { throw new Error("unexpected external open"); },
    authenticateBiometric: async () => { unlocks++; return false; },
  };
  const session = (accountId: string): MobileSession => ({
    product: "yurume", hostUrl: http.url.origin, accountId,
    accessToken: "synthetic-local-" + accountId,
    tokenType: "Bearer", createdAt: "2026-11-17T00:00:00Z",
  });
  const input = { adapter: productAdapter, nativeBridge: bridge };
  const a = (await saveMobileAccountSession({ ...input, session: session("A") }))!;
  const b = (await saveMobileAccountSession({ ...input, session: session("B") }))!;
  const scope = (accountId: string) => ({ product: "yurume" as const,
    hostUrl: http.url.origin, actorApId: http.url.origin + "/users/" + accountId });
  const accounts = createTalkRecoveryAccounts({ store: bridge.secureStore });
  const aDraft = [{ contact: { type: "community" as const, apId: "https://peer.example/groups/one" },
    content: "A's unsent group draft", attachments: [], sendState: "draft" as const }];
  await accounts.bind(a, scope("A")).save(aDraft);
  const contact = { type: "user" as const, ap_id: "https://peer.example/users/alice",
    preferred_username: "alice", name: "Alice", icon_url: null,
    last_message: null, last_message_at: null, unread_count: 0 };
  const talks: ReturnType<typeof createTalkController>[] = [];
  const createTalk = () => {
    const talk = createTalkController({ session: session("B"),
      actorApId: scope("B").actorApId,
      recovery: createTalkRecoveryAccounts({ store: bridge.secureStore }).bind(b, scope("B")),
      refreshHome: async () => {}, observedMessageIds: () => [] });
    talks.push(talk); return talk;
  };
  const first = createTalk();
  await first.open(contact);
  first.setDraft("B's original uncertain message");
  await first.send();
  first.setDraft("B's newer draft");
  await first.flushRecovery();
  first.dispose();
  const bDraft = await accounts.bind(b, scope("B")).load();
  const app = createApp(() => bridge);
  let homes = 0;
  const controller = createMobileClientController({
    adapter: app.adapter, nativeBridge: app.createNativeBridge(),
    sessionUnlock: app.sessionUnlock, onAccountScopeRetired: app.onAccountScopeRetired,
    loadHome: async () => { homes++; return undefined; },
    fetch: async () => { throw new Error("unexpected identity request"); },
  });
  return { bridge, secure, input, a, b, scope, aDraft, bDraft, contact, app, controller,
    createTalk, counts: () => ({ sends, unlocks, homes }),
    refuseCleanup: (value: boolean) => { refuseCleanup = value; },
    async close() {
      controller.stop(); talks.forEach(t => t.dispose());
      await app.disposeAndroidBack(); http.stop(true);
    } };
}

for (const defect of ["missing", "mismatched"] as const) {
  test(`the ${defect} credential retirement clears only its talk account and preserves a real unknown send`, async () => {
    const f = await fixture();
    try {
      expect(f.bDraft).toMatchObject([{ content: "B's newer draft", sendState: "uncertain",
        intent: { content: "B's original uncertain message" } }]);
      await f.controller.start();
      expect(f.controller.getState().lockedSession?.accountId).toBe("B");
      expect(f.counts().unlocks).toBe(0);
      await f.controller.unlockSession();
      expect(f.controller.getState().session).toBeUndefined();
      expect(f.counts().unlocks).toBe(1);
      await f.controller.switchAccount(f.a.id);
      await f.controller.switchAccount(f.b.id);
      await f.controller.switchAccount("not-a-saved-account");
      const saved = createTalkRecoveryAccounts({ store: f.bridge.secureStore });
      expect(await saved.bind(f.a, f.scope("A")).load()).toEqual(f.aDraft);
      expect(await saved.bind(f.b, f.scope("B")).load()).toEqual(f.bDraft);
      const key = mobileAccountSessionStorageKey(productAdapter, f.a.id);
      if (defect === "missing") f.secure.delete(key);
      else {
        const stored = JSON.parse(f.secure.get(key)!);
        f.secure.set(key, JSON.stringify({ ...stored, accountId: "foreign-subject" }));
      }
      await f.controller.switchAccount(f.a.id);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect((await loadMobileAccounts(f.input)).accounts.map(row => row.id)).toEqual([f.b.id]);
      expect(f.controller.getState().lockedSession?.accountId).toBe("B");
      expect(f.controller.getState().session).toBeUndefined();
      expect(f.counts().homes).toBe(0);
      const recreated = createTalkRecoveryAccounts({ store: { ...f.bridge.secureStore! } });
      expect(await recreated.bind(f.a, f.scope("A")).load()).toBeNull();
      expect(await recreated.bind(f.b, f.scope("B")).load()).toEqual(f.bDraft);
      const talk = f.createTalk();
      await talk.open(f.contact);
      expect(talk.state()).toMatchObject({ content: "B's newer draft", uncertain: true, canSend: false,
        recovery: { intent: { content: "B's original uncertain message" } } });
      await talk.send();
      expect(f.counts().sends).toBe(1);
    } finally { await f.close(); }
  });
}

test("failed product talk cleanup keeps a durable retry intent and the other account's unknown send", async () => {
  const f = await fixture();
  try {
    await f.controller.start();
    f.refuseCleanup(true);
    f.secure.delete(mobileAccountSessionStorageKey(productAdapter, f.a.id));
    await f.controller.switchAccount(f.a.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await loadMobileAccounts(f.input)).accounts.map(row => row.id)).toEqual([f.b.id]);
    expect(f.controller.getState().status).toBe("サインアウトしましたが、このアカウントの下書き削除を確認できませんでした。");
    const recreated = createTalkRecoveryAccounts({ store: { ...f.bridge.secureStore! } });
    const pending = await recreated.pendingCleanup(await loadMobileAccounts(f.input));
    expect(pending).toEqual([{ id: f.a.id, hostUrl: f.a.hostUrl, product: "yurume" }]);
    expect(await recreated.bind(f.a, f.scope("A")).load()).toEqual(f.aDraft);
    expect(await recreated.bind(f.b, f.scope("B")).load()).toEqual(f.bDraft);
    // Retry consumes the durable intent created by the real callback. These
    // are the same pendingCleanup/retire operations used by the product retry;
    // this is not a device click or a new retirement inferred from absence.
    f.refuseCleanup(false);
    for (const row of pending) await recreated.retire(row);
    expect(await recreated.pendingCleanup(await loadMobileAccounts(f.input))).toEqual([]);
    const after = createTalkRecoveryAccounts({ store: { ...f.bridge.secureStore! } });
    expect(await after.bind(f.a, f.scope("A")).load()).toBeNull();
    expect(await after.bind(f.b, f.scope("B")).load()).toEqual(f.bDraft);
    expect(f.counts().sends).toBe(1);
  } finally { await f.close(); }
});

function storeHandle(): TauriStoreHandle {
  const values = new Map<string, unknown>();
  return { get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => { values.set(key, value); },
    delete: async key => values.delete(key), save: async () => {} };
}

test("explicit startup retry reuses Yurumeet's default bridge after native initialization rejects", async () => {
  let loads = 0;
  const failure = new Error("synthetic Stronghold initialization refusal");
  const handle = storeHandle();
  const bridge = createTauriMobileDefaultProductBridge({
    productAdapter, keychainService: "com.yurumeet", isTauriRuntime: () => true,
    platform: { platform: () => "android" },
    invoke: async <T>() => "synthetic-existing-vault-password" as T,
    path: { appDataDir: async () => "/synthetic", join: async (...parts) => parts.join("/") },
    deepLink: { getCurrent: async () => null, onOpenUrl: async () => () => {} },
    opener: { openUrl: async () => { throw new Error("unexpected external open"); } },
    store: { load: async () => handle },
    stronghold: { load: async () => {
      if (++loads === 1) throw failure;
      const client = { getStore: () => ({ get: async () => null, insert: async () => {}, remove: async () => null }) };
      return { loadClient: async () => client, createClient: async () => client, save: async () => {} };
    } },
  });
  const app = createApp(() => bridge);
  const controller = createMobileClientController({ adapter: app.adapter,
    nativeBridge: app.createNativeBridge(), sessionUnlock: app.sessionUnlock,
    onAccountScopeRetired: app.onAccountScopeRetired,
    fetch: async () => { throw new Error("unexpected identity request"); } });
  try {
    await expect(controller.start()).rejects.toBe(failure);
    await Promise.resolve(); expect(loads).toBe(1);
    await controller.start(); expect(loads).toBe(2);
    expect(app.createNativeBridge()).toBe(bridge);
    expect(await bridge.secureStore!.get("absent")).toBeUndefined();
    expect(loads).toBe(2);
    expect(controller.getState().accounts).toEqual([]);
  } finally { controller.stop(); await app.disposeAndroidBack(); }
});

test("quality delivers Kit658 without changing the existing host source input", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
  expect(/MOBILE_KIT_SOURCE_REF:\s*([a-f0-9]{40})/.exec(workflow)?.[1]).toBe("65820519d2e73befa550b96cd974c49b232cc41b");
  expect(/TAKOSUMI_SOURCE_REF:\s*([a-f0-9]{40})/.exec(workflow)?.[1]).toBe("2045296016a91b6ba2ca5066fdfb622c8d8fd1e3");
});
