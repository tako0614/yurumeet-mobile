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
import {
  CONTACTS_RESPONSE,
  CURRENT_ACTOR_RESPONSE,
  MESSAGES_RESPONSE,
  READ_RESPONSE,
  SENT_MESSAGE_RESPONSE,
  type TalkActor,
  type TalkContact,
  type TalkMessage,
} from "./talk-response.ts";

export type { TalkContact, TalkMessage } from "./talk-response.ts";

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
    (cause instanceof MobileApiError && (cause.status >= 500 || cause.status === 408));
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
    const value = await createMobileApiClient({ session: selected }).wire(path, decoder, {
      ...init, signal: owned.signal, credentials: "omit", redirect: "error", cache: "no-store",
    });
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
): Promise<YurumeetMobileHome> {
  const [me, contacts] = await Promise.all([
    response(
      session,
      session.productEndpoints?.currentUser ?? "/api/auth/me",
      CURRENT_ACTOR_RESPONSE,
    ),
    response(
      session,
      session.productEndpoints?.conversations ?? "/api/dm/contacts",
      CONTACTS_RESPONSE,
    ),
  ]);
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

export async function sendUserMessage(
  session: MobileSession,
  actorApId: string,
  content: string,
  signal?: AbortSignal,
): Promise<TalkMessage> {
  return response(
    session,
    `/api/dm/user/${encodeURIComponent(actorApId)}/messages`,
    SENT_MESSAGE_RESPONSE,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
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
): Promise<TalkMessage> {
  return response(
    session,
    `/api/communities/${encodeURIComponent(communityApId)}/messages`,
    SENT_MESSAGE_RESPONSE,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
      signal,
    },
    true,
  );
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
