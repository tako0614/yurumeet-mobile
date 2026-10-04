import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
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
  type YurumeetMobileHome,
} from "./api.ts";
import { createTalkController, type TalkState } from "./talk-controller.ts";

export function TalkScreen(props: {
  home?: YurumeetMobileHome;
  session: MobileSession;
  refreshHome: () => Promise<void>;
  isActive?: () => boolean;
}) {
  const [state, setState] = createSignal<TalkState>({
    messages: [], content: "", loading: false, sending: false, error: "",
  });
  const controller = createTalkController({
    session: props.session,
    refreshHome: () => props.refreshHome(),
    onChange: setState,
    isActive: () => props.isActive?.() !== false,
  });
  createEffect(() => controller.updateSession(props.session));
  onCleanup(() => controller.dispose());
  const selected = () => state().selected;
  const messages = () => state().messages;
  const content = () => state().content;
  const loading = () => state().loading;
  const sending = () => state().sending;
  const error = () => state().error;

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
                onClick={() => controller.back()}
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
                    onClick={() => void controller.open(contact())}
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
                  void controller.send();
                }}
              >
                <MobileComposeField label="本文">
                  <textarea
                    maxlength={2000}
                    value={content()}
                    onInput={(event) => controller.setDraft(event.currentTarget.value)}
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
                        disabled: sending() || loading(),
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
                  onClick={() => void controller.open(contact)}
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
