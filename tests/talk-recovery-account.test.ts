import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createTalkRecoveryAccounts } from "../src/talk-recovery-account.ts";

function secureStore() {
  const values = new Map<string, string>();
  return { kind: "secure" as const, async get(key: string) { return values.get(key); },
    async set(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  } satisfies MobileSecureStore;
}
const account = { id: "saved_account_A_001", hostUrl: "https://recovery.example", product: "yurume" as const };
const scope = { hostUrl: account.hostUrl, product: "yurume" as const, actorApId: "https://recovery.example/users/me" };
const draft = { contact: { type: "user" as const, apId: "https://peer.example/users/alice" },
  content: "保存した日本語の下書き", attachments: [], sendState: "draft" as const };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("a saved account row restores its own draft and does not expose it to a fresh same-actor row", async () => {
  const store = secureStore(), first = createTalkRecoveryAccounts({ store });
  await first.bind(account, scope).save([draft]);
  const restarted = createTalkRecoveryAccounts({ store });
  expect(await restarted.bind(account, scope).load()).toEqual([draft]);
  expect(await restarted.bind({ ...account, id: "saved_account_B_002" }, scope).load()).toBeNull();
});

test("retiring an inactive old row clears only that row and fences all its existing handles", async () => {
  const store = secureStore(), first = createTalkRecoveryAccounts({ store });
  const old = first.bind(account, scope), sibling = first.bind(account, { ...scope, apiBaseUrl: scope.hostUrl + "/other-api" });
  const replacement = { ...account, id: "saved_account_B_002" };
  const fresh = first.bind(replacement, scope);
  await old.save([draft]);
  await sibling.save([{ ...draft, content: "別APIの古い下書き" }]);
  await fresh.save([{ ...draft, content: "再ログイン後の新しい下書き" }]);
  const restarted = createTalkRecoveryAccounts({ store });
  await restarted.retire(account);
  await expect(old.load()).rejects.toThrow();
  await expect(sibling.save([draft])).rejects.toThrow();
  expect(() => restarted.bind(account, scope)).toThrow(/retired/i);
  await restarted.retire(account);
  expect(await fresh.load()).toEqual([{ ...draft, content: "再ログイン後の新しい下書き" }]);
});

test("the active saved row is selected by canonical host and subject, independently of the verified actor", async () => {
  const recovery = createTalkRecoveryAccounts({ store: secureStore() });
  const row = { ...account, hostUrl: "https://RECOVERY.example:443/", accountId: "oidc-subject", lastUsedAt: "2026-11-10T00:00:00Z" };
  const session = { product: "yurume" as const, hostUrl: account.hostUrl, accountId: "oidc-subject",
    accessToken: "synthetic-never-persist", tokenType: "Bearer", createdAt: "2026-11-10T00:00:00Z" };
  const accounts = { activeId: row.id, accounts: [row] };
  await recovery.select({ accounts, session, actorApId: scope.actorApId }).save([draft]);
  expect(await recovery.bind(account, scope).load()).toEqual([draft]);
  for (const invalid of [
    { ...accounts, activeId: "saved_other_row_003" },
    { ...accounts, accounts: [{ ...row, accountId: "different-subject" }] },
    { ...accounts, accounts: [{ ...row, hostUrl: "https://other.example" }] },
    { ...accounts, accounts: [{ ...row, product: "takos" as const }] },
  ]) expect(() => recovery.select({ accounts: invalid, session, actorApId: scope.actorApId })).toThrow(/scope/i);
});

test("row retirement fences in-flight and queued writes and survives an explicit purge retry", async () => {
  const base = secureStore(), entered = deferred(), release = deferred();
  let hold = false, failDelete = true;
  const failure = new Error("synthetic account purge failure");
  const store: MobileSecureStore = { ...base,
    async set(key, value) { if (hold) { hold = false; entered.resolve(); await release.promise; } await base.set(key, value); },
    async delete(key) { if (failDelete) { failDelete = false; throw failure; } await base.delete(key); },
  };
  const recovery = createTalkRecoveryAccounts({ store }), a = recovery.bind(account, scope);
  const b = recovery.bind({ ...account, id: "saved_account_B_002" }, scope);
  await b.save([{ ...draft, content: "Bの保持対象" }]);
  hold = true;
  const pending = a.save([draft]).catch(error => error);
  await entered.promise;
  const queued = a.save([{ ...draft, content: "queued A" }]).catch(error => error);
  const removed = recovery.retire(account).catch(error => error);
  release.resolve();
  const results = await Promise.all([pending, queued, removed]);
  expect(results[0]).toBeInstanceOf(Error);
  expect(results[1]).toBeInstanceOf(Error);
  expect(results[2]).toMatchObject({ code: "storage", cause: failure });
  expect(() => recovery.bind(account, scope)).toThrow(/retired/i);
  await createTalkRecoveryAccounts({ store }).retire(account);
  expect(await b.load()).toEqual([{ ...draft, content: "Bの保持対象" }]);
});

test("an unreadable envelope cannot be overwritten or transplanted and explicit row removal still works", async () => {
  const base = secureStore();
  let captured = "", override: string | undefined, sets = 0, deletes = 0;
  const store: MobileSecureStore = { ...base,
    async get(key) { return override ?? base.get(key); },
    async set(key, value) { sets++; captured = value; await base.set(key, value); },
    async delete(key) { deletes++; await base.delete(key); },
  };
  const recovery = createTalkRecoveryAccounts({ store }), a = recovery.bind(account, scope);
  await a.save([draft]);
  override = captured;
  await expect(recovery.bind({ ...account, id: "saved_account_B_002" }, scope).load()).rejects.toThrow();
  override = "not-json";
  await expect(a.save([{ ...draft, content: "replacement" }])).rejects.toThrow();
  expect(sets).toBe(1);
  expect(deletes).toBe(0);
  await recovery.retire(account);
  expect(deletes).toBe(1);
});
