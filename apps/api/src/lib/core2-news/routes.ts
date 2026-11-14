import { Core2Error } from "@/lib/core2/contracts";
import {
  errorResponse,
  extractAuthContext,
  extractBearer,
  jsonResponse,
  readBoundedJson,
} from "@/lib/core2/http";
import type { Core2NewsDeps } from "./contracts";
import {
  closeIncidentWithAfterReport,
  getAfterReport,
  getGentleNewsState,
  getHeardStatus,
  handleSarvamNewsTool,
  handleTwilioHeardGather,
  handleTwilioHeardStatus,
  markHurtIncident,
  recordDeviceHeardAck,
  respondCircleOffer,
  tickDueGentleNews,
} from "./service";
import { createProductionCore2NewsDeps } from "./supabase";

const MAX_DEVICE_BODY_BYTES = 16 * 1024;
const MAX_FORM_BODY_BYTES = 32 * 1024;

let defaultDeps: Core2NewsDeps | null = null;
function resolveDeps(deps?: Core2NewsDeps): Core2NewsDeps {
  if (deps) return deps;
  if (!defaultDeps) {
    defaultDeps = createProductionCore2NewsDeps();
  }
  return defaultDeps;
}

async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) {
    throw new Core2Error("invalid_request", 400, "Request body is required");
  }
  if (buf.byteLength > maxBytes) {
    throw new Core2Error("invalid_request", 400, "Request body exceeds maximum size");
  }
  return new Uint8Array(buf);
}

export async function handleMarkHurtPost(
  request: Request,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const auth = extractAuthContext(request);
    const body = await readBoundedJson(request);
    const result = await markHurtIncident(resolveDeps(deps), auth, body);
    return jsonResponse(result.body, result.status);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGentleNewsGet(
  request: Request,
  incidentId: string,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const auth = extractAuthContext(request);
    const dto = await getGentleNewsState(resolveDeps(deps), auth, incidentId);
    return jsonResponse(dto, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGentleNewsQueryGet(
  request: Request,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const incidentId = url.searchParams.get("incident_id") ?? "";
    const auth = extractAuthContext(request);
    const dto = await getGentleNewsState(resolveDeps(deps), auth, incidentId);
    return jsonResponse(dto, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleCircleOfferPost(
  request: Request,
  incidentId: string,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const auth = extractAuthContext(request);
    const body = await readBoundedJson(request);
    const dto = await respondCircleOffer(resolveDeps(deps), auth, incidentId, body);
    return jsonResponse(dto, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGentleNewsTickPost(
  request: Request,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const cronHeader =
      request.headers.get("x-cron-secret") ?? extractBearer(request) ?? null;
    const res = await tickDueGentleNews(resolveDeps(deps), cronHeader);
    return jsonResponse(res, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleSarvamNewsToolPost(
  request: Request,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const token =
      extractBearer(request) ?? request.headers.get("x-sarvam-tool-token") ?? null;
    const body = await readBoundedJson(request);
    const res = await handleSarvamNewsTool(resolveDeps(deps), token, body);
    return jsonResponse(res, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleCloseIncidentPost(
  request: Request,
  incidentId: string,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const auth = extractAuthContext(request);
    const report = await closeIncidentWithAfterReport(resolveDeps(deps), auth, incidentId);
    return jsonResponse(report, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleAfterReportGet(
  request: Request,
  incidentId: string,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const auth = extractAuthContext(request);
    const report = await getAfterReport(resolveDeps(deps), auth, incidentId);
    return jsonResponse(report, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleDeviceHeardPost(
  request: Request,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const rawBytes = await readBoundedBytes(request, MAX_DEVICE_BODY_BYTES);
    const result = await recordDeviceHeardAck(resolveDeps(deps), request, rawBytes);
    return jsonResponse(result, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleTwilioHeardGatherPost(
  request: Request,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const rawBytes = await readBoundedBytes(request, MAX_FORM_BODY_BYTES);
    const rawForm = new TextDecoder().decode(rawBytes);
    const result = await handleTwilioHeardGather(resolveDeps(deps), request, rawForm);
    return new Response(result.twiml, {
      status: 200,
      headers: {
        "content-type": "text/xml; charset=utf-8",
        "cache-control": "no-store",
        "x-sahaj-heard": result.heard ? "true" : "false",
        "x-sahaj-badge-label": encodeURIComponent(result.badge_label),
        ...(result.receipt_id ? { "x-sahaj-receipt-id": result.receipt_id } : {}),
        ...(result.evidence_type ? { "x-sahaj-evidence-type": result.evidence_type } : {}),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleTwilioHeardStatusPost(
  request: Request,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const rawBytes = await readBoundedBytes(request, MAX_FORM_BODY_BYTES);
    const rawForm = new TextDecoder().decode(rawBytes);
    const result = await handleTwilioHeardStatus(resolveDeps(deps), request, rawForm);
    return jsonResponse(result, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleHeardStatusGet(
  request: Request,
  deps?: Core2NewsDeps,
): Promise<Response> {
  try {
    const auth = extractAuthContext(request);
    const url = new URL(request.url);
    const deliveryId =
      url.searchParams.get("delivery_id") ??
      url.searchParams.get("reassurance_id") ??
      url.searchParams.get("voice_post_id") ??
      "";
    const messageKind = url.searchParams.get("message_kind");
    const status = await getHeardStatus(resolveDeps(deps), auth, {
      deliveryId,
      messageKind,
    });
    return jsonResponse(status, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
