import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
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
import {
  displayHostRoutePath,
  hostRouteNoticeFor,
  type HostRouteNotice,
} from "./host-route.ts";

/** Shown when a link asked for a host screen that this app does not have. */
export function HostRouteNoticeBanner(props: {
  notice?: HostRouteNotice;
  session: MobileSession;
  onDismiss: () => void;
}) {
  return (
    <Show when={hostRouteNoticeFor(props.notice, props.session)}>
      {(notice) => (
        <div class="route-notice" role="status">
          <p>
            リンク先の画面（{displayHostRoutePath(notice().path)}）はアプリにありません。トークを表示しています。
          </p>
          <button type="button" class="text-button" onClick={() => props.onDismiss()}>
            閉じる
          </button>
        </div>
      )}
    </Show>
  );
}

export function TalkScreen(props: {
  home?: YurumeetMobileHome;
  session: MobileSession;
  refreshHome: () => Promise<void>;
  isActive?: () => boolean;
}) {
  const [state, setState] = createSignal<TalkState>({
    messages: [], content: "", loading: false, loadingOlder: false, refreshing: false, gaps: [], hasMore: undefined, historyError: "",
    sending: false, uncertain: false, canSend: false, error: "",
  });
  let surface!: HTMLDivElement;
  const controller = createTalkController({
    session: props.session,
    refreshHome: () => props.refreshHome(),
    onChange: next => {
      const previous = state();
      const opened = previous.loading && !next.loading && !!next.selected && !next.error;
      const follow = previous.selected === next.selected && !next.loadingOlder &&
        previous.messages.at(-1)?.id !== next.messages.at(-1)?.id &&
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 64;
      setState(next);
      if (opened || follow) queueMicrotask(() => {
        if (surface?.isConnected && state().selected === next.selected &&
          props.isActive?.() !== false && document.visibilityState !== "hidden") {
          window.scrollTo(0, document.documentElement.scrollHeight);
        }
      });
    },
    isActive: () => props.isActive?.() !== false,
    observedMessageIds: () => [...(surface?.querySelectorAll<HTMLLIElement>(".message-list li[data-message-id]") ?? [])]
      .filter(row => { const bounds = row.getBoundingClientRect(); return bounds.bottom > 0 && bounds.top < window.innerHeight; })
      .map(row => row.dataset.messageId!),
    receive: {
      isForeground: () => document.visibilityState !== "hidden",
      canMarkRead: () => !!surface?.isConnected,
    },
  });
  createEffect(() => controller.updateSession(props.session));
  onCleanup(() => controller.dispose());
  onMount(() => {
    const update = () => controller.foregroundChanged();
    const readVisible = () => controller.readVisible();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("online", update);
    window.addEventListener("scroll", readVisible, { passive: true });
    onCleanup(() => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("online", update);
      window.removeEventListener("scroll", readVisible);
    });
  });
  const selected = () => state().selected;
  const messages = () => state().messages;
  const content = () => state().content;
  const loading = () => state().loading;
  const sending = () => state().sending;
  const error = () => state().error;

  async function loadOlder() {
    const contact = selected();
    const anchor = surface.querySelector<HTMLLIElement>(".message-list li");
    const top = anchor?.getBoundingClientRect().top;
    const scroll = window.scrollY;
    await controller.loadOlder();
    if (anchor?.isConnected && top !== undefined && selected() === contact && window.scrollY === scroll) {
      window.scrollBy(0, anchor.getBoundingClientRect().top - top);
    }
  }

  async function loadGap(beforeId: string) {
    const contact = selected();
    const anchor = [...surface.querySelectorAll<HTMLLIElement>(".message-list li")]
      .find(element => element.dataset.messageId === beforeId);
    const top = anchor?.getBoundingClientRect().top, scroll = window.scrollY;
    await controller.loadGap(beforeId);
    if (anchor?.isConnected && top !== undefined && selected() === contact && window.scrollY === scroll) {
      window.scrollBy(0, anchor.getBoundingClientRect().top - top);
    }
  }

  return (
    <div class="talk-surface" ref={surface}>
      <Show when={selected()}>
        {(contact) => (
          <MobilePreviewSection
            title={contact().name ?? contact().preferred_username}
            actions={
              <div>
                <button
                  type="button"
                  class="text-button"
                  disabled={loading() || state().refreshing || state().loadingOlder || sending()}
                  aria-busy={state().refreshing}
                  onClick={() => controller.foregroundChanged()}
                >
                  {state().refreshing ? "新着を確認中…" : "新着を確認"}
                </button>
              <button
                type="button"
                class="text-button"
                onClick={() => controller.back()}
              >
                戻る
              </button>
              </div>
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
              <Show when={state().hasMore !== undefined}>
                <button
                  type="button"
                  class="text-button"
                  disabled={state().hasMore !== true || state().loadingOlder}
                  aria-busy={state().loadingOlder}
                  onClick={() => void loadOlder()}
                >
                  {state().loadingOlder ? "以前のメッセージを読み込み中…" : state().hasMore
                    ? "以前のメッセージを読み込む" : "これより前のメッセージはありません"}
                </button>
              </Show>
              <Show when={state().historyError}>
                <p class="talk-error" role="alert">{state().historyError}</p>
              </Show>
              <Show when={state().hasMore === undefined && !error()}>
                <p class="empty">以前のメッセージの有無を確認できません。</p>
              </Show>
              <MobilePreviewList class="message-list">
                <For each={messages()}>
                  {(message) => (
                    <li
                      data-message-id={message.id}
                      class={
                        message.sender.ap_id === props.home?.actor.ap_id
                          ? "mine"
                          : ""
                      }
                    >
                      <Show when={state().gaps.find(gap => gap.beforeId === message.id)}>
                        {(gap) => (
                          <div class="talk-gap" role="status">
                            <p>この間のメッセージは未確認です。</p>
                            <Show when={gap().canLoad} fallback={<p>このサーバーでは続きを確認できません。トークを開き直してください。</p>}>
                              <button
                                type="button"
                                class="text-button"
                                disabled={state().loadingOlder || loading()}
                                onClick={() => void loadGap(message.id)}
                              >
                                間のメッセージを取得
                              </button>
                            </Show>
                          </div>
                        )}
                      </Show>
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
              <Show when={state().uncertain}>
                <p role="status">送信結果が未確認です。トークを更新し、同じ内容が届いていないか確認してから操作してください。</p>
              </Show>
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
                      !state().canSend
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
