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

async function response<T>(
  session: MobileSession,
  path: string,
  decoder: WireDecoder<T>,
  init?: RequestInit,
  uncertainSend = false,
): Promise<T> {
  try {
    return await createMobileApiClient({ session }).wire(path, decoder, init);
  } catch (cause) {
    // A successful HTTP response can follow a committed send even when its
    // JSON is malformed. Keep the draft and surface uncertainty; never resend.
    if (
      cause instanceof WireDecodeError ||
      cause instanceof SyntaxError ||
      (uncertainSend && !(cause instanceof MobileApiError))
    ) {
      throw new YurumeetResponseError(path, cause, uncertainSend);
    }
    throw cause;
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
): Promise<TalkMessage[]> {
  return response(
    session,
    `/api/dm/user/${encodeURIComponent(actorApId)}/messages?limit=50`,
    MESSAGES_RESPONSE,
  );
}

export async function sendUserMessage(
  session: MobileSession,
  actorApId: string,
  content: string,
): Promise<TalkMessage> {
  return response(
    session,
    `/api/dm/user/${encodeURIComponent(actorApId)}/messages`,
    SENT_MESSAGE_RESPONSE,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    },
    true,
  );
}

export async function loadCommunityMessages(
  session: MobileSession,
  communityApId: string,
): Promise<TalkMessage[]> {
  return response(
    session,
    `/api/communities/${encodeURIComponent(communityApId)}/messages?limit=50`,
    MESSAGES_RESPONSE,
  );
}

export async function sendCommunityMessage(
  session: MobileSession,
  communityApId: string,
  content: string,
): Promise<TalkMessage> {
  return response(
    session,
    `/api/communities/${encodeURIComponent(communityApId)}/messages`,
    SENT_MESSAGE_RESPONSE,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    },
    true,
  );
}

export async function markTalkAsRead(
  session: MobileSession,
  contact: Pick<TalkContact, "type" | "ap_id">,
): Promise<void> {
  const kind = contact.type === "community" ? "community" : "user";
  return response(
    session,
    `/api/dm/${kind}/${encodeURIComponent(contact.ap_id)}/read`,
    READ_RESPONSE,
    { method: "POST" },
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
