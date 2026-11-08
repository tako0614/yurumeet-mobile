import type { BackAction } from "./android-back-navigation.ts";
import type { createTalkController } from "./talk-controller.ts";
import type { createTalkDiscoveryController } from "./talk-discovery.ts";

/** Match the product's existing topmost cancel/leave actions, never a write. */
export function createTalkBackAction(options: {
  talk: Pick<ReturnType<typeof createTalkController>, "state" | "cancelRejectRequest" | "cancelMessageAction" | "back">;
  discovery: Pick<ReturnType<typeof createTalkDiscoveryController>, "state">;
  closeDiscovery: () => void;
}): BackAction {
  return () => {
    const current = options.talk.state();
    if (current.requests?.confirmation) options.talk.cancelRejectRequest();
    else if (current.messageAction) {
      if (current.messageAction.canCancel) options.talk.cancelMessageAction();
      else options.talk.back(); // Preserve a submitted change for readback.
    } else if (options.discovery.state().visible) options.closeDiscovery();
    else options.talk.back();
  };
}
