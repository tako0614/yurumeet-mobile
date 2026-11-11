import { createEffect, createMemo, createRenderEffect, createSignal, createUniqueId, For, Index, onCleanup, onMount, Show } from "solid-js";
import type { BackAction } from "./android-back-navigation.ts";
import { createTalkBackAction } from "./talk-back.ts";
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
import { createTalkDiscoveryController, type TalkDiscoveryState } from "./talk-discovery.ts";
import { talkSessionIdentity } from "./talk-session.ts";
import { TalkMedia } from "./talk-media.tsx";
import type { createTalkRecoveryStore } from "./talk-recovery.ts";
import type { TalkNotificationRequest } from "./talk-notification.ts";
import type { TalkRequest } from "./talk-response.ts";
import type { TalkMessageActionState } from "./talk-message-actions.ts";
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

function RequestRejectionDialog(props: { request: TalkRequest; cancel: () => void; confirm: () => void }) {
  let dialog!: HTMLDialogElement;
  let cancel!: HTMLButtonElement;
  const title = createUniqueId();
  const opener = document.activeElement;
  onMount(() => { dialog.showModal(); cancel.focus(); });
  onCleanup(() => {
    dialog.close();
    if (opener instanceof HTMLElement && opener.isConnected && !opener.hasAttribute("disabled")) opener.focus();
  });
  return <dialog ref={dialog} class="request-confirmation" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); props.cancel(); }}>
    <h3 id={title}>受信トークを拒否しますか？</h3>
    <p>{props.request.sender.name ?? props.request.sender.preferred_username}</p>
    <p class="request-address">{props.request.sender.ap_id}</p>
    <p>この相手との現在のトークにある受信メッセージを削除します。元には戻せません。相手をブロックしません。</p>
    <p>同じ相手との古い別の履歴がある場合は、一覧に残ることがあります。</p>
    <div class="request-actions">
      <button ref={cancel} type="button" class="text-button" onClick={() => props.cancel()}>戻る</button>
      <button type="button" class="text-button request-reject" onClick={() => props.confirm()}>受信トークを拒否</button>
    </div>
  </dialog>;
}

function MessageDeleteDialog(props: {
  action: TalkMessageActionState;
  cancel: () => void;
  confirm: () => void;
  reconcile: () => void;
  leave: () => void;
}) {
  let dialog!: HTMLDialogElement, cancel!: HTMLButtonElement, reconcile: HTMLButtonElement | undefined;
  const title = createUniqueId(), opener = document.activeElement;
  onMount(() => { dialog.showModal(); cancel.focus(); });
  createEffect(() => {
    if (props.action.needsReadback && !props.action.loading && !props.action.pending) queueMicrotask(() => reconcile?.focus());
  });
  onCleanup(() => { dialog.close(); queueMicrotask(() => {
    if (opener instanceof HTMLElement && opener.isConnected && !opener.hasAttribute("disabled")) opener.focus();
  }); });
  return <dialog ref={dialog} class="request-confirmation message-delete-dialog" aria-labelledby={title}
    aria-busy={props.action.loading || props.action.pending}
    onCancel={event => { event.preventDefault(); props.action.canCancel ? props.cancel() : props.leave(); }}>
    <h3 id={title}>メッセージを削除しますか？</h3>
    <p class="message-delete-preview">{props.action.serverContent || "本文のないメッセージ"}</p>
    <p>このサーバーの本文と添付を削除します。相手側の表示は接続先によって異なります。元には戻せません。</p>
    <Show when={props.action.error}><p class="talk-error" role="alert">{props.action.error}</p></Show>
    <Show when={props.action.loading || props.action.pending}><p role="status">{props.action.pending ? "削除の結果を確認中…" : "現在のメッセージを確認中…"}</p></Show>
    <div class="message-action-buttons">
      <button ref={cancel} type="button" class="text-button" disabled={!props.action.canCancel} onClick={() => props.cancel()}>戻る</button>
      <Show when={props.action.needsReadback && !props.action.loading && !props.action.pending}>
        <button ref={reconcile} type="button" class="text-button" onClick={() => props.reconcile()}>現在の1件を確認</button>
      </Show>
      <button type="button" class="text-button request-reject" disabled={!props.action.canSave} onClick={() => props.confirm()}>メッセージを削除</button>
      <button type="button" class="text-button" onClick={() => props.leave()}>トーク一覧へ</button>
    </div>
    <Show when={props.action.pending || !props.action.canCancel}><small>一覧に戻っても、確認中の変更は取り消されません。</small></Show>
  </dialog>;
}

function MessageEditPanel(props: {
  action: TalkMessageActionState;
  setContent: (value: string) => void;
  save: () => void;
  cancel: () => void;
  reconcile: () => void;
  leave: () => void;
}) {
  let field!: HTMLTextAreaElement, focused = false;
  createEffect(() => { if (!props.action.loading && !focused) { focused = true; queueMicrotask(() => field?.focus()); } });
  return <MobileComposeSection title="メッセージを編集">
    <Show when={props.action.error}><p class="talk-error" role="alert">{props.action.error}</p></Show>
    <Show when={props.action.loading}><p role="status">現在のメッセージを確認中…</p></Show>
    <MobileComposeForm onSubmit={event => { event.preventDefault(); props.save(); }}>
      <MobileComposeField label="編集する本文">
        <textarea ref={field} value={props.action.content} maxlength={5000} disabled={props.action.loading}
          onInput={event => props.setContent(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape" && props.action.canCancel) { event.preventDefault(); props.cancel(); }
          }} />
      </MobileComposeField>
      <MobileComposeFooter detail={`あと ${Math.max(0, 5000 - props.action.content.trim().length)} 文字`}>
        <button type="submit" class="primary" disabled={!props.action.canSave} aria-busy={props.action.pending}>{props.action.pending ? "保存中…" : "変更を保存"}</button>
      </MobileComposeFooter>
    </MobileComposeForm>
    <div class="message-action-buttons">
      <button type="button" class="text-button" disabled={!props.action.canCancel} onClick={() => props.cancel()}>編集を閉じる</button>
      <Show when={props.action.needsReadback && !props.action.loading && !props.action.pending}>
        <button type="button" class="text-button" onClick={() => props.reconcile()}>現在の1件を確認</button>
      </Show>
      <button type="button" class="text-button" onClick={() => props.leave()}>トーク一覧へ</button>
    </div>
    <Show when={!props.action.loading && !props.action.needsReadback && props.action.serverContent !== props.action.content.trim()}>
      <details class="message-current-content"><summary>サーバーの現在の本文</summary><p>{props.action.serverContent || "本文のないメッセージ"}</p></details>
    </Show>
  </MobileComposeSection>;
}

export function TalkScreen(props: {
  onBackTarget?: (back: BackAction | undefined) => void;
  home?: YurumeetMobileHome;
  session: MobileSession;
  refreshHome: () => Promise<void>;
  isActive?: () => boolean;
  notificationRequest?: TalkNotificationRequest;
  onNotificationConsumed?: (request: TalkNotificationRequest) => void;
  recovery?: ReturnType<typeof createTalkRecoveryStore>;
}) {
  const [foreground, setForeground] = createSignal(document.visibilityState !== "hidden", { equals: false });
  const [fileSelectionError, setFileSelectionError] = createSignal("");
  let acceptFiles: ((files: readonly File[]) => boolean) | undefined;
  const [state, setState] = createSignal<TalkState>({
    retainedContacts: [],
    attachments: [], attachmentError: "", canAddAttachments: false,
    messages: [], content: "", loading: false, loadingOlder: false, refreshing: false, gaps: [], hasMore: undefined, historyError: "",
    sending: false, uncertain: false, canSend: false, canManageMessages: false, error: "",
  });
  let surface!: HTMLDivElement;
  let peopleInput: HTMLInputElement | undefined, newTalkButton: HTMLButtonElement | undefined;
  const peopleInputId = createUniqueId();
  const [discovery, setDiscovery] = createSignal<TalkDiscoveryState>({ visible: false, query: "", people: [],
    searched: false, loading: false, opening: undefined, hasMore: false, error: "" });
  const controller = createTalkController({
    session: props.session,
    recovery: props.recovery,
    actorApId: props.home?.actor.ap_id,
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
      canMarkRead: () => !!surface?.isConnected && !state().messageAction &&
        !document.querySelector("dialog[open]"),
    },
  });
  const discoveryController = createTalkDiscoveryController({ session: props.session, actorApId: props.home?.actor.ap_id,
    isActive: () => props.isActive?.() !== false && document.visibilityState !== "hidden",
    onChange: setDiscovery, onOpen: contact => { void controller.open(contact); } });
  function closeDiscovery() {
    discoveryController.close();
    queueMicrotask(() => { if (newTalkButton?.isConnected) newTalkButton.focus(); });
  }
  const goBack = createTalkBackAction({ talk: controller, discovery: discoveryController, closeDiscovery });
  createRenderEffect(() => {
    const current = state();
    props.onBackTarget?.(
      current.selected || current.requests?.visible || discovery().visible ? goBack : undefined,
    );
  });
  onCleanup(() => props.onBackTarget?.(undefined));
  createEffect(() => {
    controller.updateSession(props.session); controller.updateActor(props.home?.actor.ap_id);
    discoveryController.updateSession(props.session, props.home?.actor.ap_id);
  });
  createEffect(() => { if (state().selected || state().requests?.visible) discoveryController.close(); });
  createEffect(() => {
    const request = props.notificationRequest, home = props.home;
    if (!request) return;
    if (request.sessionKey !== talkSessionIdentity(props.session)) {
      return;
    }
    if (!home || !foreground() || document.visibilityState === "hidden" || props.isActive?.() === false) return;
    controller.updateSession(props.session);
    props.onNotificationConsumed?.(request);
    void controller.openNotification(request, home.actor.ap_id);
  });
  onCleanup(() => { discoveryController.dispose(); controller.dispose(); });
  onMount(() => {
    void controller.restoreRecovery();
    const update = () => {
      if (document.visibilityState === "hidden") void controller.flushRecovery();
      setForeground(document.visibilityState !== "hidden"); controller.foregroundChanged();
      if (document.visibilityState === "hidden") discoveryController.suspend();
    };
    const readVisible = () => controller.readVisible();
    document.addEventListener("visibilitychange", update);
    const persist = () => { void controller.flushRecovery(); };
    window.addEventListener("pagehide", persist);
    window.addEventListener("online", update);
    window.addEventListener("scroll", readVisible, { passive: true });
    onCleanup(() => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", persist);
      window.removeEventListener("online", update);
      window.removeEventListener("scroll", readVisible);
    });
  });
  const selected = () => state().selected;
  const contacts = createMemo(() => {
    const canonical = props.home?.contacts ?? [];
    const keys = new Set(canonical.map(contact => JSON.stringify([contact.type, contact.ap_id])));
    return [...canonical, ...state().retainedContacts.filter(contact => !keys.has(JSON.stringify([contact.type, contact.ap_id])))];
  });
  const messages = () => state().messages;
  const messageById = createMemo(() => new Map(messages().map(message => [message.id, message])));
  const messageIds = createMemo(() => [...messageById().keys()]);
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
      <Show when={state().recovery}>
        {recovery => <>
          <Show when={recovery().loading || recovery().saving}><p role="status">{recovery().loading ? "保存した下書きを確認中…" : "下書きを保存中…"}</p></Show>
          <Show when={recovery().reviewingExpired}><p role="status">期限切れの下書きを確認中…</p></Show>
          <Show when={recovery().error}><div role="alert" class="talk-error">
            <p>{recovery().error}</p>
            <button type="button" class="text-button" disabled={recovery().loading || recovery().saving || recovery().reviewingExpired}
              onClick={() => void controller.flushRecovery()}>下書きの確認・保存を再試行</button>
            <Show when={recovery().canReviewExpired}>
              <button type="button" class="text-button" onClick={() => void controller.reviewExpiredRecovery()}>期限切れの下書きを確認</button>
            </Show>
          </div></Show>
          <Show when={recovery().expiredDrafts}>
            {drafts => <MobilePreviewSection title="期限切れの下書き">
              <p>復元しても送信しません。相手と内容を確認してください。未確認の送信は別途確認が必要です。</p>
              <For each={drafts()}>{draft => <div>
                <strong>{draft.contact.apId}</strong>
                <p style={{ "white-space": "pre-wrap" }}>{draft.content || "本文なし"}</p>
                <For each={draft.attachments}>{attachment => <p>{attachment.phase === "ready"
                  ? `${attachment.upload.attachment.name}（有効期限内の添付）` : `${attachment.name}（元のファイルを再選択）`}</p>}</For>
                <Show when={draft.sendState !== "draft" && draft.intent}>
                  {intent => <div><p>送信結果が未確認の元の内容</p><p style={{ "white-space": "pre-wrap" }}>{intent().content || "本文なし"}</p>
                    <For each={intent().attachments}>{upload => <p>{upload.attachment.name}</p>}</For>
                  </div>}
                </Show>
              </div>}</For>
              <button type="button" class="text-button" disabled={recovery().saving}
                onClick={() => void controller.restoreExpiredRecovery()}>確認した下書きを復元</button>
              <button type="button" class="text-button" disabled={recovery().saving}
                onClick={() => controller.cancelExpiredRecoveryReview()}>確認を閉じる</button>
            </MobilePreviewSection>}
          </Show>
          <Show when={!selected() && recovery().drafts.length}>
            <MobilePreviewSection title="保存した下書き・未確認の送信">
              <For each={recovery().drafts}>{draft => <div class="message-action-buttons">
                <span>{draft.contact.apId}</span>
                <button type="button" class="text-button" onClick={() => void controller.openRecovered(draft)}>相手を確認して開く</button>
              </div>}</For>
            </MobilePreviewSection>
          </Show>
        </>}
      </Show>
      <Show when={state().notification}>
        {(notice) => <div role="status" class="talk-error">
          <p>{notice().loading ? "通知先のトークを確認中…" : notice().error}</p>
          <Show when={!notice().loading}>
            <button type="button" class="text-button" onClick={() => void controller.retryNotification()}>通知先を再確認</button>
          </Show>
          <button type="button" class="text-button" onClick={() => controller.dismissNotification()}>閉じる</button>
        </div>}
      </Show>
      <Show when={state().requests?.visible}>
        <MobilePreviewSection title="メッセージリクエスト" actions={<div class="request-actions">
          <button type="button" class="text-button" disabled={state().requests?.loading || !!state().requests?.opening || state().requests?.rejecting}
            onClick={() => void controller.refreshRequests()}>一覧を更新</button>
          <button type="button" class="text-button" onClick={() => controller.back()}>トーク一覧に戻る</button>
        </div>}>
          <p class="empty">開くだけでは承認されません。返信すると相手とのトークが承認されます。</p>
          <p class="empty">同じ相手に複数の履歴がある場合は、現在のトークを開きます。</p>
          <Show when={state().requests?.error}>
            <p class="talk-error" role="alert">{state().requests?.error}</p>
          </Show>
          <Show when={state().requests?.loading || state().requests?.rejecting}>
            <p role="status">{state().requests?.rejecting ? "拒否の結果と一覧を確認中…" : "リクエストを確認中…"}</p>
          </Show>
          <Show when={!state().requests?.loading && !state().requests?.needsRefresh && !state().requests?.items.length}>
            <p class="empty">メッセージリクエストはありません。</p>
          </Show>
          <MobilePreviewList class="request-list">
            <For each={state().requests?.items}>
              {item => <li>
                <MobilePreviewCard class="request-card">
                  <strong class="request-identity">{item.sender.name ?? item.sender.preferred_username}</strong>
                  <small class="request-address">{item.sender.ap_id}</small>
                  <p class="request-preview">{item.content || "本文のないメッセージ"}</p>
                  <small>{item.created_at ? formatMobilePreviewDate(item.created_at, "ja-JP") : ""}</small>
                  <div class="request-actions">
                    <button type="button" class="text-button"
                      disabled={state().requests?.needsRefresh || !!state().requests?.opening || state().requests?.rejecting || state().requests?.loading}
                      onClick={() => void controller.openRequest(item)}>
                      {state().requests?.opening === item.id ? "確認中…" : "現在のトークを開く"}
                    </button>
                    <button type="button" class="text-button request-reject"
                      disabled={state().requests?.needsRefresh || !!state().requests?.opening || state().requests?.rejecting || state().requests?.loading}
                      onClick={() => controller.confirmRejectRequest(item)}>受信トークを拒否…</button>
                  </div>
                </MobilePreviewCard>
              </li>}
            </For>
          </MobilePreviewList>
          <Show when={state().requests?.confirmation}>
            {item => <RequestRejectionDialog request={item()} cancel={() => controller.cancelRejectRequest()}
              confirm={() => void controller.rejectRequest()} />}
          </Show>
        </MobilePreviewSection>
      </Show>
      <Show when={selected()}>
        {(contact) => (
          <MobilePreviewSection
            title={contact().name ?? contact().preferred_username}
            actions={
              <div>
                <button
                  type="button"
                  class="text-button"
                  disabled={loading() || state().refreshing || state().loadingOlder || sending() || !!state().messageAction}
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
                    disabled={sending() || state().messageAction?.pending}
                    onClick={() => void controller.reload()}
                  >
                    トークを更新
                  </button>
                </div>
              </Show>
              <Show when={state().hasMore !== undefined}>
                <button
                  type="button"
                  class="text-button"
                  disabled={state().hasMore !== true || state().loadingOlder || !!state().messageAction}
                  aria-busy={state().loadingOlder}
                  onClick={() => void loadOlder()}
                >
                  {state().loadingOlder ? "以前のメッセージを読み込み中…" : state().hasMore
                    ? "以前のメッセージを読み込む" : "これより前のメッセージはありません"}
                </button>
              </Show>
              <Show when={state().historyError}>
                <p class="talk-error" role="alert">{state().historyError}</p>
                <button type="button" class="text-button" disabled={state().messageAction?.pending} onClick={() => void controller.reload()}>トークを更新</button>
              </Show>
              <Show when={state().hasMore === undefined && !error()}>
                <p class="empty">以前のメッセージの有無を確認できません。</p>
              </Show>
              <MobilePreviewList class="message-list">
                <For each={messageIds()}>
                  {id => <Show when={messageById().get(id)}>
                  {(message) => (
                    <li
                      data-message-id={message().id}
                      class={
                        message().sender.ap_id === props.home?.actor.ap_id
                          ? "mine"
                          : ""
                      }
                    >
                      <Show when={state().gaps.find(gap => gap.beforeId === message().id)}>
                        {(gap) => (
                          <div class="talk-gap" role="status">
                            <p>この間のメッセージは未確認です。</p>
                            <Show when={gap().canLoad} fallback={<p>このサーバーでは続きを確認できません。トークを開き直してください。</p>}>
                              <button
                                type="button"
                                class="text-button"
                                disabled={state().loadingOlder || loading() || !!state().messageAction}
                                onClick={() => void loadGap(message().id)}
                              >
                                間のメッセージを取得
                              </button>
                            </Show>
                          </div>
                        )}
                      </Show>
                      <MobilePreviewCard class="message-bubble">
                        <p>
                          {message().content || (message().attachments?.length
                            ? `添付ファイル（${message().attachments?.length}件）`
                            : "")}
                        </p>
                        <TalkMedia attachments={message().attachments} session={props.session} isActive={() => props.isActive?.() !== false && foreground()} />
                        <small>
                          {message().created_at
                            ? formatMobilePreviewDate(message().created_at ?? "", "ja-JP")
                            : ""}
                        </small>
                        <Show when={message().sender.ap_id === props.home?.actor.ap_id}>
                          <div class="message-action-buttons">
                            <button type="button" class="text-button" disabled={!state().canManageMessages} onClick={() => void controller.beginMessageEdit(message().id)}>編集</button>
                            <button type="button" class="text-button" disabled={!state().canManageMessages} onClick={() => void controller.beginMessageDelete(message().id)}>削除…</button>
                          </div>
                        </Show>
                      </MobilePreviewCard>
                    </li>
                  )}
                  </Show>}
                </For>
              </MobilePreviewList>
            </Show>
            <Show when={state().messageAction?.kind === "edit" && state().messageAction}>
              {action => <MessageEditPanel action={action()} setContent={value => controller.setMessageEditContent(value)} save={() => void controller.saveMessageEdit()}
                cancel={() => controller.cancelMessageAction()} reconcile={() => void controller.reconcileMessageAction()} leave={() => controller.back()} />}
            </Show>
            <Show when={state().messageAction?.kind === "delete" && state().messageAction}>
              {action => <MessageDeleteDialog action={action()} cancel={() => controller.cancelMessageAction()} confirm={() => void controller.confirmMessageDelete()}
                reconcile={() => void controller.reconcileMessageAction()} leave={() => controller.back()} />}
            </Show>
            <MobileComposeSection title="メッセージ">
              <Show when={state().messageAction}><p role="status">メッセージの変更・確認中は、新しい送信を待機します。</p></Show>
              <Show when={state().uncertain}>
                <p role="status">送信結果が未確認です。トークを更新し、同じ内容が届いていないか確認してから操作してください。</p>
              </Show>
              <Show when={state().recovery?.intent}>{intent => <div role="status">
                <p>再起動前の送信結果は未確認です。履歴と元の内容を確認してください。</p>
                <p class="message-delete-preview">{intent().content || "本文なし"}</p>
                <For each={intent().attachments}>{upload => <p>{upload.attachment.name}</p>}</For>
                <button type="button" class="text-button" disabled={!state().recovery?.canConfirmReview}
                  onClick={() => void controller.confirmRecoveryReview()}>履歴と元の内容を確認した・次の送信を許可</button>
                <small>この操作は届いたことを確定せず、自動再送もしません。</small>
              </div>}</Show>
              <MobileComposeForm
                onSubmit={(event) => {
                  event.preventDefault();
                  void controller.send();
                }}
              >
                <MobileComposeField label="本文">
                  <textarea
                    maxlength={2000}
                    disabled={!!state().recovery && !state().recovery?.ready}
                    value={content()}
                    onInput={(event) => controller.setDraft(event.currentTarget.value)}
                  />
                </MobileComposeField>
                <MobileComposeField label="写真・動画">
                  <input class="talk-attachment-picker" type="file" multiple
                    accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm"
                    disabled={!state().canAddAttachments}
                    onClick={() => { setFileSelectionError(""); acceptFiles = controller.captureAttachmentSelection(); }}
                    onCancel={() => { acceptFiles = undefined; }}
                    onChange={event => {
                      const files = Array.from(event.currentTarget.files ?? []), accept = acceptFiles ?? controller.captureAttachmentSelection();
                      event.currentTarget.value = ""; acceptFiles = undefined;
                      if (!accept(files)) setFileSelectionError("接続先や会話が変わりました。写真・動画をもう一度選んでください。");
                    }} />
                </MobileComposeField>
                <Show when={fileSelectionError()}>{error => <p class="talk-error" role="alert">{error()}</p>}</Show>
                <Show when={state().attachmentError}>{error => <p class="talk-error" role="alert">{error()}</p>}</Show>
                <Show when={state().attachments.length}>
                  <div class="talk-draft-attachments" role="list" aria-label="送信前の添付">
                    <Index each={state().attachments}>{item => <div class="talk-draft-attachment" role="listitem">
                      <strong>{item().name}</strong>
                      <small>{(item().size / (1024 * 1024)).toFixed(1)} MiB · {item().phase === "ready" ? "準備できました" : item().phase === "queued" ? "準備を待っています" : item().phase === "uploading" ? "添付を準備中…" : "確認が必要です"}</small>
                      <Show when={item().error}>{error => <p class="talk-error" role="alert">{error()}</p>}</Show>
                      <Show when={item().phase === "ready" && item().attachment}>
                        {attachment => <TalkMedia attachments={[attachment()]} session={props.session} isActive={() => props.isActive?.() !== false && foreground()} />}
                      </Show>
                      <div class="message-action-buttons">
                        <Show when={item().canRetry}><button type="button" class="text-button" onClick={() => controller.retryAttachment(item().id)}>添付を再試行</button></Show>
                        <button type="button" class="text-button" onClick={() => controller.removeAttachment(item().id)}>下書きから外す</button>
                      </div>
                    </div>}</Index>
                  </div>
                </Show>
                <Show when={sending()}><p role="status">送信中の内容は変わりません。追加入力は次の下書きに残ります。</p></Show>
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
      <Show when={!selected() && !state().requests?.visible}>
        <button ref={newTalkButton} type="button" class="text-button request-entry" disabled={!props.home}
          onClick={() => { discoveryController.show(); queueMicrotask(() => peopleInput?.focus()); }}>新しいトーク</button>
        <button type="button" class="text-button request-entry" disabled={!props.home}
          onClick={() => void controller.showRequests()}>メッセージリクエスト（{props.home?.requestCount ?? "…"}）</button>
        <Show when={discovery().visible}>
          <section class="people-search" aria-label="新しいトークの相手を検索" aria-busy={discovery().loading || !!discovery().opening}
            onKeyDown={event => {
              if (event.isComposing || event.keyCode === 229) {
                if (event.key === "Enter") event.preventDefault();
                return;
              }
              if (event.key === "Escape") { event.preventDefault(); closeDiscovery(); }
            }}>
            <div class="people-search-heading"><h2>新しいトーク</h2><button type="button" class="text-button" onClick={closeDiscovery}>検索を閉じる</button></div>
            <form onSubmit={event => { event.preventDefault(); void discoveryController.search(); }}>
              <label for={peopleInputId}>相手の名前・ユーザー名</label>
              <div class="people-search-fields">
                <input id={peopleInputId} ref={peopleInput} type="search" value={discovery().query} maxLength={256}
                  placeholder="名前 / @user@server" autocomplete="off"
                  onInput={event => discoveryController.setQuery(event.currentTarget.value)} />
                <button type="submit" class="primary" disabled={!discovery().query.trim() || discovery().loading || !!discovery().opening}>
                  {discovery().loading ? "検索中…" : "検索"}</button>
              </div>
            </form>
            <p class="muted">別のサーバーの相手は @user@server で検索できます。相手を選ぶだけではメッセージを送りません。</p>
            <Show when={discovery().error}><p class="error" role="alert">{discovery().error}</p></Show>
            <Show when={discovery().searched && !discovery().people.length && !discovery().loading && !discovery().error}>
              <p class="empty">相手が見つかりませんでした。名前やアドレスを確認してください。</p>
            </Show>
            <ul class="people-results">
              <For each={discovery().people}>{person => (
                <li><button type="button" class="talk-row" disabled={discovery().loading || !!discovery().opening}
                  onClick={() => void discoveryController.openPerson(person.ap_id)}>
                  <span class="talk-copy"><strong>{person.name ?? person.preferred_username}</strong><span>@{person.username}</span>
                    <small>{person.ap_id}</small></span>
                  <Show when={discovery().opening === person.ap_id}><span role="status">確認中…</span></Show>
                </button></li>
              )}</For>
            </ul>
            <Show when={discovery().hasMore}><button type="button" class="text-button"
              disabled={discovery().loading || !!discovery().opening} onClick={() => void discoveryController.more()}>ほかの検索結果を表示</button></Show>
          </section>
        </Show>
        <Show when={!discovery().visible}>
        <div class="talk-list">
          <Show
            when={contacts().length}
            fallback={<p class="empty">まだトークはありません。</p>}
          >
            <For each={contacts()}>
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
      </Show>
    </div>
  );
}
