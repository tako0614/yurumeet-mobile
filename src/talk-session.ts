import type { MobileSession } from "@takosjp/mobile-kit";

export function talkSessionIdentity(session: MobileSession) {
  return JSON.stringify([
    session.hostUrl, session.product, session.accessToken,
    session.tokenType, session.createdAt,
    session.apiBaseUrl,
    Object.entries(session.productEndpoints ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
