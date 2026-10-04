import { createSignal, For, Show } from "solid-js";
import {
  appendUniqueMobileItemsById,
  canSubmitMobileText,
  formatMobilePreviewDate,
  mobileTextRemaining,
  type MobileSession,
} from "@takosjp/mobile-kit";
import {
  MobileComposeField,
  MobileComposeFooter,
  MobileComposeForm,
  MobileComposeSection,
  MobilePreviewCard,
  MobilePreviewList,
  MobilePreviewSection,
} from "@takosjp/mobile-kit/solid";
import {
  loadCommunityMessages,
  loadUserMessages,
  markTalkAsRead,
  sendCommunityMessage,
  sendUserMessage,
  type TalkContact,
  type TalkMessage,
  type YurumeetMobileHome,
} from "./api.ts";

export function TalkScreen(props: {
  home?: YurumeetMobileHome;
  session: MobileSession;
  refreshHome: () => Promise<void>;
}) {
  const [selected, setSelected] = createSignal<TalkContact>();
  const [messages, setMessages] = createSignal<readonly TalkMessage[]>([]);
  const [content, setContent] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal("");

  async function open(contact: TalkContact) {
    setSelected(contact);
    setMessages([]);
    setError("");
    setLoading(true);
    try {
      setMessages(
        contact.type === "community"
          ? await loadCommunityMessages(props.session, contact.ap_id)
          : await loadUserMessages(props.session, contact.ap_id),
      );
      await markTalkAsRead(props.session, contact);
      await props.refreshHome();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "トークを読み込めませんでした。",
      );
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    const contact = selected();
    if (
      !contact ||
      !canSubmitMobileText({
        value: content(),
        disabled: sending(),
        maxLength: 2000,
      })
    )
      return;
    setSending(true);
    setError("");
    try {
      const message =
        contact.type === "community"
          ? await sendCommunityMessage(props.session, contact.ap_id, content())
          : await sendUserMessage(props.session, contact.ap_id, content());
      setMessages((current) => appendUniqueMobileItemsById(current, [message]));
      setContent("");
      await props.refreshHome();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "メッセージを送れませんでした。",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div class="talk-surface">
      <Show when={selected()}>
        {(contact) => (
          <MobilePreviewSection
            title={contact().name ?? contact().preferred_username}
            actions={
              <button
                type="button"
                class="text-button"
                onClick={() => setSelected(undefined)}
              >
                戻る
              </button>
            }
          >
            <Show when={!loading()} fallback={<p class="empty">読み込み中…</p>}>
              <Show when={error()}>
                <div>
                  <p class="talk-error" role="alert">
                    {error()}
                  </p>
                  <button
                    type="button"
                    class="text-button"
                    disabled={sending()}
                    onClick={() => void open(contact())}
                  >
                    トークを更新
                  </button>
                </div>
              </Show>
              <MobilePreviewList class="message-list">
                <For each={messages()}>
                  {(message) => (
                    <li
                      class={
                        message.sender.ap_id === props.home?.actor.ap_id
                          ? "mine"
                          : ""
                      }
                    >
                      <MobilePreviewCard class="message-bubble">
                        <p>
                          {message.content || (message.attachments?.length
                            ? `添付ファイル（${message.attachments.length}件）`
                            : "")}
                        </p>
                        <small>
                          {message.created_at
                            ? formatMobilePreviewDate(message.created_at, "ja-JP")
                            : ""}
                        </small>
                      </MobilePreviewCard>
                    </li>
                  )}
                </For>
              </MobilePreviewList>
            </Show>
            <MobileComposeSection title="メッセージ">
              <MobileComposeForm
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <MobileComposeField label="本文">
                  <textarea
                    maxlength={2000}
                    value={content()}
                    onInput={(event) => setContent(event.currentTarget.value)}
                  />
                </MobileComposeField>
                <MobileComposeFooter
                  detail={`あと ${mobileTextRemaining(content(), 2000)} 文字`}
                >
                  <button
                    type="submit"
                    class="primary"
                    disabled={
                      !canSubmitMobileText({
                        value: content(),
                        disabled: sending(),
                        maxLength: 2000,
                      })
                    }
                  >
                    {sending() ? "送信中" : "送信"}
                  </button>
                </MobileComposeFooter>
              </MobileComposeForm>
            </MobileComposeSection>
          </MobilePreviewSection>
        )}
      </Show>
      <Show when={!selected()}>
        <div class="talk-list">
          <Show
            when={props.home?.contacts.length}
            fallback={<p class="empty">まだトークはありません。</p>}
          >
            <For each={props.home?.contacts}>
              {(contact) => (
                <button
                  class="talk-row"
                  type="button"
                  onClick={() => void open(contact)}
                >
                  <Show
                    when={contact.icon_url}
                    fallback={
                      <span class="avatar-fallback">
                        {(contact.name ?? contact.preferred_username).slice(
                          0,
                          1,
                        )}
                      </span>
                    }
                  >
                    <img src={contact.icon_url!} alt="" />
                  </Show>
                  <span class="talk-copy">
                    <strong>
                      {contact.name ?? contact.preferred_username}
                    </strong>
                    <small>
                      {contact.last_message?.content ?? "トークを始める"}
                    </small>
                  </span>
                  <span class="talk-meta">
                    <small>
                      {contact.last_message_at
                        ? new Date(contact.last_message_at).toLocaleDateString()
                        : ""}
                    </small>
                    <Show when={contact.unread_count}>
                      <b>{contact.unread_count}</b>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
