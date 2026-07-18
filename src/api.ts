import {
  createMobileApiClient,
  normalizeNotificationPusherGatewayUrl,
  registerNotificationPusherWithHost,
  unregisterNotificationPusherWithHost,
  type MobilePushRegistrationCallbackInput,
  type MobileSession,
} from "@takosjp/mobile-kit";

export interface TalkContact {
  type: "user" | "community";
  ap_id: string;
  preferred_username: string;
  name: string | null;
  icon_url: string | null;
  last_message: { content: string; is_mine: boolean } | null;
  last_message_at: string | null;
  unread_count?: number;
}

export interface YurumeetMobileHome {
  actor: { ap_id: string; preferred_username: string; name: string | null };
  contacts: TalkContact[];
  requestCount: number;
  unread: number;
}

export interface TalkMessage {
  id: string;
  content: string;
  created_at: string;
  sender: { ap_id: string; name: string | null; preferred_username: string };
}

export async function loadHome(
  session: MobileSession,
): Promise<YurumeetMobileHome> {
  const api = createMobileApiClient({ session });
  const [me, contacts] = await Promise.all([
    api.json<{ actor: YurumeetMobileHome["actor"] }>(
      session.productEndpoints?.currentUser ?? "/api/auth/me",
    ),
    api.json<{
      mutual_followers?: TalkContact[];
      communities?: TalkContact[];
      request_count?: number;
    }>(session.productEndpoints?.conversations ?? "/api/dm/contacts"),
  ]);
  const all = [
    ...(contacts.mutual_followers ?? []),
    ...(contacts.communities ?? []),
  ].sort((a, b) =>
    (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
  );
  return {
    actor: me.actor,
    contacts: all,
    requestCount: contacts.request_count ?? 0,
    unread: all.reduce((sum, item) => sum + (item.unread_count ?? 0), 0),
  };
}

export async function loadUserMessages(
  session: MobileSession,
  actorApId: string,
): Promise<TalkMessage[]> {
  const data = await createMobileApiClient({ session }).json<{
    messages?: TalkMessage[];
  }>(`/api/dm/user/${encodeURIComponent(actorApId)}/messages?limit=50`);
  return data.messages ?? [];
}

export async function sendUserMessage(
  session: MobileSession,
  actorApId: string,
  content: string,
): Promise<TalkMessage> {
  const data = await createMobileApiClient({ session }).json<{
    message: TalkMessage;
  }>(`/api/dm/user/${encodeURIComponent(actorApId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return data.message;
}

export async function loadCommunityMessages(
  session: MobileSession,
  communityApId: string,
): Promise<TalkMessage[]> {
  const data = await createMobileApiClient({ session }).json<{
    messages?: TalkMessage[];
  }>(`/api/communities/${encodeURIComponent(communityApId)}/messages?limit=50`);
  return data.messages ?? [];
}

export async function sendCommunityMessage(
  session: MobileSession,
  communityApId: string,
  content: string,
): Promise<TalkMessage> {
  const data = await createMobileApiClient({ session }).json<{
    message: TalkMessage;
  }>(`/api/communities/${encodeURIComponent(communityApId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return data.message;
}

export async function markTalkAsRead(
  session: MobileSession,
  contact: Pick<TalkContact, "type" | "ap_id">,
): Promise<void> {
  const kind = contact.type === "community" ? "community" : "user";
  await createMobileApiClient({ session }).json(
    `/api/dm/${kind}/${encodeURIComponent(contact.ap_id)}/read`,
    { method: "POST" },
  );
}

export async function registerPush(input: MobilePushRegistrationCallbackInput) {
  const gateway = normalizeNotificationPusherGatewayUrl(
    import.meta.env.VITE_YURUMEET_NOTIFICATION_PUSHER_GATEWAY_URL,
  );
  if (!gateway)
    throw new Error("Yurumeet notification gateway is not configured.");
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
