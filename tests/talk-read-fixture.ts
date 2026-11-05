/** Synthetic HTTP replies for controller-only fixtures, not Core/runtime proof. */
export function observedInitAck() {
  return Response.json({ success: true, read_observed: { version: 1, max_ids: 50 } });
}

export function observedMessageAck(init?: RequestInit) {
  if (typeof init?.body !== "string") throw new Error("Expected observed-ID body");
  const { message_ids } = JSON.parse(init.body) as { message_ids: string[] };
  if (!Array.isArray(message_ids)) throw new Error("Expected message_ids");
  return Response.json({ success: true, message_ids });
}
