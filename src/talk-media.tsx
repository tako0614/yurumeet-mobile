import { createMemo, createRenderEffect, createSignal, Index, onCleanup, Show } from "solid-js";
import type { MobileSession } from "@takosjp/mobile-kit";
import { createTalkMediaController, describeTalkMedia, type TalkMediaSource, type TalkMediaState } from "./talk-media.ts";

export function TalkMedia(props: { attachments?: unknown; session: MobileSession; isActive: () => boolean }) {
  const sources = createMemo(() => describeTalkMedia(props.attachments, props.session.hostUrl));
  return <Show when={sources().length}>
    <div class="talk-media" role="list" aria-label="メッセージの添付">
      <Index each={sources()}>{source => <MediaItem source={source()} session={props.session} isActive={props.isActive} />}</Index>
    </div>
  </Show>;
}

function MediaItem(props: { source: TalkMediaSource; session: MobileSession; isActive: () => boolean }) {
  const [state, setState] = createSignal<TalkMediaState>({ phase: "idle" });
  const controller = createTalkMediaController({ session: props.session, source: props.source, onChange: setState });
  createRenderEffect(() => controller.update(props.session, props.source, props.isActive()));
  onCleanup(() => controller.dispose());
  return <div class="talk-media-item" role="listitem">
    <Show when={props.source.kind !== "unavailable"} fallback={<p role="status">{props.source.label}はアプリで表示できない形式です。</p>}>
      <Show when={state().phase === "ready" && state().url} fallback={<>
        <p>{props.source.label}</p>
        <Show when={state().error}>{error => <p class="talk-error" role="alert">{error()}</p>}</Show>
        <button type="button" class="text-button" disabled={!props.isActive() || state().phase === "loading"} aria-busy={state().phase === "loading"} onClick={() => void controller.load()}>
          {state().phase === "loading" ? "読み込み中…" : state().phase === "error" ? "添付を再試行" : props.source.kind === "video" ? "動画を表示" : "画像を表示"}
        </button>
      </>}>
        {url => <Show when={props.source.kind === "video"} fallback={<img src={url()} alt={props.source.label} crossOrigin="anonymous" referrerPolicy="no-referrer" onError={event => controller.failed(event.currentTarget.src)} />}>
          <video src={url()} controls playsinline preload="none" crossOrigin="anonymous" aria-label={props.source.label} onError={event => controller.failed(event.currentTarget.src)} />
        </Show>}
      </Show>
    </Show>
  </div>;
}
