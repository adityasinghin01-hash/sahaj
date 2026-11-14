import { AdapterError, requireAuthorization, type ProviderRequest } from "./contracts";
import { isRecord, parseJson, send } from "./http";
import type { SarvamConfig } from "./sarvam";

const ANALYTICS_HOST = "https://apps.sarvam.ai/api/analytics/v1";
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const INTERACTION_ID = /^\d{8}\/(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/;
const PAGE = 200, MAX_PAGES = 5;

/**
 * Confirm with Sarvam that `attemptId` produced `interactionId` for this agent, using List attempts
 * (GET .../analytics/v1/{org}/{workspace}/{app}/attempts, X-API-Key). Sarvam's post-call webhook is unsigned, so an
 * interaction id in a webhook body is never trusted to fetch a recording until this returns true.
 * Authorization action: "sarvam.attempts.read".
 *
 * Provider facts used (Sarvam "List attempts" reference and its example response): required `start_datetime` and
 * `end_datetime` query parameters, `limit` 1-1000, `offset`, `sort_by=attempt_id`; each item carries `attempt_id` and `interaction_id`.
 * Items also carry the user's unmasked phone number. Only the two ids are read; nothing else is kept or logged.
 * Not verified against a live account: that every attempt appears in the page range for the window given, so a
 * `false` means "not confirmed", never "proved different".
 */
export async function verifySarvamAttemptInteraction(
  deps: SarvamConfig,
  request: ProviderRequest<{ appId: string; attemptId: string; interactionId: string; windowStart: Date; windowEnd: Date }>,
): Promise<{ confirmed: boolean }> {
  requireAuthorization(request, "sarvam.attempts.read");
  const { appId, attemptId, interactionId, windowStart, windowEnd } = request.payload;
  if (!deps.apiKey || !SAFE_ID.test(deps.orgId) || !SAFE_ID.test(deps.workspaceId) || !SAFE_ID.test(appId) || !SAFE_ID.test(attemptId) || !INTERACTION_ID.test(interactionId)
    || !(windowStart instanceof Date) || !(windowEnd instanceof Date) || !(windowStart.getTime() < windowEnd.getTime())) {
    throw new AdapterError("invalid_payload", "sarvam");
  }
  const base = `${ANALYTICS_HOST}/${encodeURIComponent(deps.orgId)}/${encodeURIComponent(deps.workspaceId)}/${encodeURIComponent(appId)}/attempts`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ start_datetime: windowStart.toISOString(), end_datetime: windowEnd.toISOString(), limit: String(PAGE), offset: String(page * PAGE), sort_by: "attempt_id", sort_order: "asc" });
    const res = await send(`${base}?${q.toString()}`, { method: "GET", headers: { "X-API-Key": deps.apiKey } },
      { provider: "sarvam", transport: deps.transport, timeoutMs: deps.timeoutMs ?? 30_000, maxBytes: 8 * 1024 * 1024, readOnly: true });
    const body = parseJson(res.body, "sarvam");
    const items = body.items;
    if (!Array.isArray(items)) throw new AdapterError("provider_rejected", "sarvam", res.status);
    for (const item of items) {
      if (isRecord(item) && item.attempt_id === attemptId) return { confirmed: item.interaction_id === interactionId };
    }
    const total = typeof body.total === "number" ? body.total : null;
    if (items.length < PAGE || (total !== null && (page + 1) * PAGE >= total)) break;
  }
  return { confirmed: false };
}
