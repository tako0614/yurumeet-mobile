import {
  createMobileApiClient,
  MobileApiError,
  WireDecodeError,
  normalizeNotificationPusherGatewayUrl,
  registerNotificationPusherWithHost,
  unregisterNotificationPusherWithHost,
  type MobilePushRegistrationCallbackInput,
  type MobileSession,
  type WireDecoder,
} from "@takosjp/mobile-kit";
import type { ClientOptions } from "@tauri-apps/plugin-http";
import { talkUploadResponse, type TalkMessageAttachment } from "./talk-attachments.ts";
import {
  CONTACTS_RESPONSE,
  CURRENT_ACTOR_RESPONSE,
  MESSAGES_RESPONSE,
  MESSAGES_PAGE_RESPONSE,
  READ_RESPONSE,
  OBSERVED_READ_INIT_RESPONSE,
  observedReadResponse,
  notificationTargetResponse,
  notificationContactResponse,
  REQUESTS_RESPONSE,
  REQUEST_REJECT_RESPONSE,
  ownedTalkMessageResponse,
  ownedTalkEditResponse,
  OWNED_TALK_DELETE_RESPONSE,
  isTalkMessageRevision,
  isGroupMessageRevision,
  ownedGroupMessageResponse,
  ownedGroupEditResponse,
  ownedGroupDeleteResponse,
  sentMessageResponse,
  talkPeopleResponse,
  type TalkActor,
  type TalkContact,
  type TalkMessage,
  type TalkMessagePage,
  type TalkRequest,
} from "./talk-response.ts";
import { isTalkNotificationId, type TalkNotificationRequest } from "./talk-notification.ts";

export type { TalkContact, TalkMessage } from "./talk-response.ts";

function ownedTalkPath(id: string) {
  if (!isTalkNotificationId(id)) throw new Error("メッセージの情報を確認できませんでした。");
  return `/api/dm/messages/${encodeURIComponent(id)}`;
}

export async function loadOwnedTalkMessage(session: MobileSession, id: string, actorApId: string, signal?: AbortSignal) {
  const path = ownedTalkPath(id);
  try { return await response(session, path, ownedTalkMessageResponse(id, actorApId), { signal }); }
  catch (cause) {
    if (cause instanceof MobileApiError && cause.status === 404 && cause.detail === "owned_dm_not_found") return null;
    throw cause; // An unsupported host404 is not a deletion observation.
  }
}

export async function editOwnedTalkMessage(session: MobileSession, id: string, content: string, revision: string, signal?: AbortSignal) {
  const path = ownedTalkPath(id);
  if (!content.trim() || content.trim().length > 5000 || !isTalkMessageRevision(revision)) throw new Error("編集内容を確認してください。");
  return response(session, path, ownedTalkEditResponse(id, content), { method: "PATCH", headers: {
    "content-type": "application/json", "if-match": JSON.stringify(revision),
  }, body: JSON.stringify({ content }), signal }, true);
}

export async function deleteOwnedTalkMessage(session: MobileSession, id: string, revision: string, signal?: AbortSignal) {
  const path = ownedTalkPath(id);
  if (!isTalkMessageRevision(revision)) throw new Error("メッセージの現在の状態を確認してください。");
  return response(session, path, OWNED_TALK_DELETE_RESPONSE, { method: "DELETE", headers: { "if-match": JSON.stringify(revision) }, signal }, true);
}

function ownedGroupTalkPath(communityApId: string, id: string) {
  if (!isTalkNotificationId(communityApId) || !isTalkNotificationId(id)) throw new Error("グループとメッセージの情報を確認できませんでした。");
  return `/api/communities/${encodeURIComponent(communityApId)}/messages/${encodeURIComponent(id)}`;
}

export async function loadOwnedGroupTalkMessage(session: MobileSession, communityApId: string, id: string, actorApId: string, signal?: AbortSignal) {
  const path = ownedGroupTalkPath(communityApId, id);
  try { return await response(session, path, ownedGroupMessageResponse(id, actorApId, communityApId), { signal }); }
  catch (cause) {
    if (cause instanceof MobileApiError && cause.status === 404 && cause.detail === "owned_group_message_not_found") return null;
    throw cause; // A missing/unsupported community route does not prove absence.
  }
}

export async function editOwnedGroupTalkMessage(session: MobileSession, communityApId: string, id: string, content: string, revision: string, signal?: AbortSignal) {
  const path = ownedGroupTalkPath(communityApId, id);
  if (!content.trim() || content.trim().length > 5000 || !isGroupMessageRevision(revision)) throw new Error("編集内容を確認してください。");
  return response(session, path, ownedGroupEditResponse(id, content, communityApId), { method: "PATCH", headers: {
    "content-type": "application/json", "if-match": JSON.stringify(revision),
  }, body: JSON.stringify({ content }), signal }, true);
}

export async function deleteOwnedGroupTalkMessage(session: MobileSession, communityApId: string, id: string, revision: string, signal?: AbortSignal) {
  const path = ownedGroupTalkPath(communityApId, id);
  if (!isGroupMessageRevision(revision)) throw new Error("メッセージの現在の状態を確認してください。");
  return response(session, path, ownedGroupDeleteResponse(id, communityApId), { method: "DELETE", headers: { "if-match": JSON.stringify(revision) }, signal }, true);
}

export async function loadTalkRequests(session: MobileSession, signal?: AbortSignal): Promise<TalkRequest[]> {
  return response(session, "/api/dm/requests", REQUESTS_RESPONSE, { signal });
}

export async function loadTalkRequestContact(session: MobileSession, senderApId: string, signal?: AbortSignal): Promise<TalkContact> {
  if (!isTalkNotificationId(senderApId)) throw new Error("相手の情報を確認できませんでした。");
  return response(session, `/api/dm/contact/${encodeURIComponent(senderApId)}`,
    notificationContactResponse({ type: "user", ap_id: senderApId }), { signal });
}

export async function searchTalkPeople(session: MobileSession, query: string, offset = 0, signal?: AbortSignal) {
  const term = query.trim();
  if (!term || term.length > 256 || /[\u0000-\u001f\u007f]/u.test(term) ||
    !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000 || offset % 20 !== 0) {
    throw new Error("名前または @user@server を256文字以内で入力してください。");
  }
  const handle = term.replace(/^@/u, ""), remote = handle.includes("@");
  if (remote && (!/^[^\s@/]+@[^\s@/]+$/u.test(handle) || offset !== 0)) {
    throw new Error("相手のアドレスを @user@server の形で入力してください。");
  }
  const params = new URLSearchParams({ q: term, ...(remote ? {} : { limit: "20", offset: String(offset) }) });
  return response(session, `/api/search/${remote ? "remote" : "actors"}?${params}`,
    talkPeopleResponse(offset, remote), { signal });
}

export async function rejectTalkRequest(session: MobileSession, senderApId: string, signal?: AbortSignal): Promise<void> {
  if (!isTalkNotificationId(senderApId)) throw new Error("相手の情報を確認できませんでした。");
  return response(session, "/api/dm/requests/reject-pending", REQUEST_REJECT_RESPONSE,
    { method: "POST", body: JSON.stringify({ sender_ap_id: senderApId, block: false }), signal });
}

export interface YurumeetMobileHome {
  actor: TalkActor;
  contacts: TalkContact[];
  requestCount: number;
  unread: number;
}

export class YurumeetResponseError extends Error {
  readonly path: string;
  readonly uncertainSend: boolean;

  constructor(path: string, cause: unknown, uncertainSend: boolean) {
    super(
      uncertainSend
        ? "送信結果を確認できませんでした。再送する前にトークを開き直して、届いているか確認してください。"
        : "サーバーの応答を確認できませんでした。更新してもう一度確認してください。",
      { cause },
    );
    this.name = "YurumeetResponseError";
    this.path = path;
    this.uncertainSend = uncertainSend;
  }
}

/** Preserve genuine HTTP status/detail while classifying an ambiguous send. */
export function isUncertainMessageSend(cause: unknown): boolean {
  return (cause instanceof YurumeetResponseError && cause.uncertainSend) ||
    // A no-follow redirect can arrive after a committed POST. Only definite
    // client rejections (apart from request timeout) acknowledge no success.
    (cause instanceof MobileApiError && !(cause.status >= 400 && cause.status < 500 && cause.status !== 408));
}

async function response<T>(
  session: MobileSession,
  path: string,
  decoder: WireDecoder<T>,
  init?: RequestInit,
  uncertainSend = false,
): Promise<T> {
  const selected = {
    ...session,
    productEndpoints: session.productEndpoints ? { ...session.productEndpoints } : undefined,
  };
  const owned = new AbortController();
  const caller = init?.signal;
  const cancel = () => owned.abort(caller?.reason);
  caller?.addEventListener("abort", cancel, { once: true });
  if (caller?.aborted) cancel();
  const deadline = setTimeout(() => owned.abort(new Error(
    "サーバーの応答を時間内に確認できませんでした。状態を確認してから操作してください。",
  )), 15_000);
  try {
    if (owned.signal.aborted) throw owned.signal.reason;
    const request: RequestInit & Pick<ClientOptions, "maxRedirections"> = {
      ...init, signal: owned.signal, credentials: "omit", redirect: "error", maxRedirections: 0, cache: "no-store", referrerPolicy: "no-referrer",
    };
    const value = await createMobileApiClient({ session: selected }).wire(path, decoder, request);
    if (owned.signal.aborted) throw owned.signal.reason;
    return value;
  } catch (cause) {
    const failure = owned.signal.aborted && !(cause instanceof MobileApiError)
      ? owned.signal.reason ?? cause : cause;
    // A successful HTTP response can follow a committed send even when its
    // JSON is malformed. Keep the draft and surface uncertainty; never resend.
    if (
      failure instanceof WireDecodeError ||
      failure instanceof SyntaxError ||
      (uncertainSend && !(failure instanceof MobileApiError))
    ) {
      throw new YurumeetResponseError(path, failure, uncertainSend);
    }
    throw failure;
  } finally {
    clearTimeout(deadline);
    caller?.removeEventListener("abort", cancel);
    owned.abort();
  }
}

export async function loadHome(
  session: MobileSession,
  signal?: AbortSignal,
): Promise<YurumeetMobileHome> {
  const selected = {
    ...session,
    productEndpoints: session.productEndpoints ? { ...session.productEndpoints } : undefined,
  };
  const read = new AbortController();
  const cancel = () => read.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    if (read.signal.aborted) throw read.signal.reason;
    const [me, contacts] = await Promise.all([
      response(
        selected,
        selected.productEndpoints?.currentUser ?? "/api/auth/me",
        CURRENT_ACTOR_RESPONSE,
        { signal: read.signal },
      ),
      response(
        selected,
        selected.productEndpoints?.conversations ?? "/api/dm/contacts",
        CONTACTS_RESPONSE,
        { signal: read.signal },
      ),
    ]);
    if (read.signal.aborted) throw read.signal.reason;
    const all = [
      ...contacts.mutual_followers,
      ...contacts.communities,
    ].sort((a, b) =>
      (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
    );
    return {
      actor: me.actor,
      contacts: all,
      requestCount: contacts.request_count,
      unread: all.reduce((sum, item) => sum + item.unread_count, 0),
    };
  } finally {
    signal?.removeEventListener("abort", cancel);
    // A failed half of the home read must close its unfinished sibling too.
    read.abort();
  }
}

export async function loadUserMessages(
  session: MobileSession,
  actorApId: string,
  signal?: AbortSignal,
): Promise<TalkMessage[]> {
  return response(
    session,
    `/api/dm/user/${encodeURIComponent(actorApId)}/messages?limit=50`,
    MESSAGES_RESPONSE,
    { signal },
  );
}

/** Resolve on the selected host, then fetch its canonical contact without guessing. */
export async function loadTalkNotificationContact(
  session: MobileSession,
  request: Pick<TalkNotificationRequest, "eventId" | "objectId">,
  recipientApId: string,
  signal?: AbortSignal,
): Promise<TalkContact> {
  if (!isTalkNotificationId(request.eventId) || !isTalkNotificationId(recipientApId) ||
    (request.objectId !== undefined && !isTalkNotificationId(request.objectId))) {
    throw new Error("通知の情報を確認できませんでした。");
  }
  const selected = { ...session, productEndpoints: session.productEndpoints ? { ...session.productEndpoints } : undefined };
  const query = new URLSearchParams({ event_id: request.eventId,
    ...(request.objectId !== undefined ? { object_id: request.objectId } : {}) });
  const read = new AbortController();
  const cancel = () => read.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(() => read.abort(new Error("通知先を時間内に確認できませんでした。再確認してください。")), 15_000);
  try {
    if (read.signal.aborted) throw read.signal.reason;
    const target = await response(selected, `/api/dm/notification-target?${query}`,
      notificationTargetResponse(request.eventId, recipientApId), { signal: read.signal });
    if (read.signal.aborted) throw read.signal.reason;
    return await response(selected, `/api/dm/contact/${encodeURIComponent(target.ap_id)}`,
      notificationContactResponse(target), { signal: read.signal });
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    read.abort();
  }
}

export async function loadTalkMessagePage(
  session: MobileSession,
  contact: Pick<TalkContact, "type" | "ap_id">,
  signal?: AbortSignal,
  before?: string,
): Promise<TalkMessagePage> {
  const query = new URLSearchParams({ limit: "50" });
  if (before !== undefined) {
    if (!before.trim()) throw new Error("以前のメッセージの位置を確認できませんでした。");
    query.set("before", before);
  }
  const path = contact.type === "community"
    ? `/api/communities/${encodeURIComponent(contact.ap_id)}/messages`
    : `/api/dm/user/${encodeURIComponent(contact.ap_id)}/messages`;
  return response(session, `${path}?${query}`, MESSAGES_PAGE_RESPONSE, { signal });
}

export async function sendUserMessage(
  session: MobileSession,
  actorApId: string,
  content: string,
  signal?: AbortSignal,
  attachments: readonly TalkMessageAttachment[] = [],
  expectedSender?: string,
): Promise<TalkMessage> {
  return response(
    session,
    `/api/dm/user/${encodeURIComponent(actorApId)}/messages`,
    sentMessageResponse(content, attachments, expectedSender),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, ...(attachments.length ? { attachments } : {}) }),
      signal,
    },
    true,
  );
}

export async function loadCommunityMessages(
  session: MobileSession,
  communityApId: string,
  signal?: AbortSignal,
): Promise<TalkMessage[]> {
  return response(
    session,
    `/api/communities/${encodeURIComponent(communityApId)}/messages?limit=50`,
    MESSAGES_RESPONSE,
    { signal },
  );
}

export async function sendCommunityMessage(
  session: MobileSession,
  communityApId: string,
  content: string,
  signal?: AbortSignal,
  attachments: readonly TalkMessageAttachment[] = [],
  expectedSender?: string,
): Promise<TalkMessage> {
  return response(
    session,
    `/api/communities/${encodeURIComponent(communityApId)}/messages`,
    sentMessageResponse(content, attachments, expectedSender),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, ...(attachments.length ? { attachments } : {}) }),
      signal,
    },
    true,
  );
}

export async function uploadTalkAttachment(session: MobileSession, file: File, signal: AbortSignal) {
  const body = new FormData(); body.set("file", file);
  return response(session, "/api/media/upload", talkUploadResponse(file), { method: "POST", body, signal });
}

export async function markTalkAsRead(
  session: MobileSession,
  contact: Pick<TalkContact, "type" | "ap_id">,
  signal?: AbortSignal,
): Promise<void> {
  const kind = contact.type === "community" ? "community" : "user";
  return response(
    session,
    `/api/dm/${kind}/${encodeURIComponent(contact.ap_id)}/read`,
    READ_RESPONSE,
    { method: "POST", signal },
  );
}

function observedReadPath(contact: Pick<TalkContact, "type" | "ap_id">) {
  return `/api/dm/${contact.type === "community" ? "community" : "user"}/${encodeURIComponent(contact.ap_id)}/read-observed`;
}

export async function initializeObservedTalkRead(
  session: MobileSession,
  contact: Pick<TalkContact, "type" | "ap_id">,
  signal?: AbortSignal,
): Promise<void> {
  await response(session, `${observedReadPath(contact)}/init`, OBSERVED_READ_INIT_RESPONSE, { method: "POST", signal });
}

export async function acknowledgeObservedTalkMessages(
  session: MobileSession,
  contact: Pick<TalkContact, "type" | "ap_id">,
  observed: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const ids = [...observed];
  if (ids.some(id => !id.trim() || id.trim() !== id || id.length > 2048) || new Set(ids).size !== ids.length) {
    throw new Error("確認済みメッセージのIDが不正です。");
  }
  const selected = { ...session, productEndpoints: session.productEndpoints ? { ...session.productEndpoints } : undefined };
  const path = observedReadPath(contact);
  const encoder = new TextEncoder();
  let offset = 0;
  while (offset < ids.length) {
    const chunk: string[] = [];
    while (offset < ids.length && chunk.length < 50) {
      const next = [...chunk, ids[offset]];
      if (encoder.encode(JSON.stringify({ message_ids: next })).length > 32768) break;
      chunk.push(ids[offset++]);
    }
    if (!chunk.length) throw new Error("確認済みメッセージのIDが大きすぎます。");
    await response(selected, path, observedReadResponse(chunk), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_ids: chunk }), signal,
    });
  }
}

export async function registerPush(input: MobilePushRegistrationCallbackInput) {
  // The connected host owns the gateway allowlist and one binary talks to many
  // self-hosted servers, so the build-time URL is only a fallback: mobile-kit
  // asks the host first and throws a named error when neither side has one.
  const gateway =
    normalizeNotificationPusherGatewayUrl(
      import.meta.env.VITE_YURUMEET_NOTIFICATION_PUSHER_GATEWAY_URL,
    ) ?? "";
  const provider = input.registration.provider;
  if (provider !== "apns" && provider !== "fcm")
    throw new Error("Unsupported push provider.");
  await registerNotificationPusherWithHost({
    session: input.session,
    pusher: {
      kind: "http",
      app_id: "com.yurumeet",
      app_display_name: "Yurumeet",
      pushkey: input.registration.token,
      data: {
        url: gateway,
        format: "event_id_only",
        provider,
        environment: input.registration.environment ?? "production",
      },
    },
  });
}
export async function unregisterPush(
  input: MobilePushRegistrationCallbackInput,
) {
  await unregisterNotificationPusherWithHost({
    session: input.session,
    appId: "com.yurumeet",
    pushkey: input.registration.token,
  });
}
