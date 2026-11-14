import { describe, expect, it } from "vitest";
import type { MediaAuthorizationContext } from "../../src/lib/media/contracts";
import { cedarMediaAuthorizer } from "../../src/lib/media/cedar-authorizer";

const F = "00000000-0000-4000-8000-000000000001", SENDER = "00000000-0000-4000-8000-000000000002", RECIPIENT = "00000000-0000-4000-8000-000000000003";
const POST = "00000000-0000-4000-8000-000000000004", CALL = "00000000-0000-4000-8000-000000000005", OTHER = "00000000-0000-4000-8000-000000000006";
const NOW = "2026-11-14T10:00:00.000Z", FUTURE = "2026-12-01T00:00:00.000Z";
const voice = (over: Partial<MediaAuthorizationContext> = {}): MediaAuthorizationContext => ({ action: "read_voice_media", familyId: F,
  actor: { userId: "u", personId: RECIPIENT, role: "child" }, subject: { kind: "voice_post", id: POST, senderId: SENDER, recipientId: RECIPIENT },
  consent: { id: "c", purpose: `voice_share:${RECIPIENT}`, personId: SENDER, callId: null, grantedAt: "2026-11-10T00:00:00.000Z" },
  object: { bucket: "sahaj-voice", path: "p", expiresAt: FUTURE }, now: NOW, ...over });
const recording = (over: Partial<MediaAuthorizationContext> = {}): MediaAuthorizationContext => ({ action: "read_call_recording", familyId: F,
  actor: { userId: "u", personId: SENDER, role: "parent" }, subject: { kind: "call", id: CALL, personId: SENDER },
  consent: { id: "c", purpose: "call_recording", personId: SENDER, callId: CALL, grantedAt: "2026-11-10T00:00:00.000Z" },
  object: { bucket: "sahaj-recordings", path: "p", expiresAt: FUTURE }, now: NOW, ...over });

describe("Cedar media authorizer (fixed MEDIA_READ_POLICY)", () => {
  it("allows the sender or recipient of a voice post and the recorded parent for their own call", async () => {
    expect(await cedarMediaAuthorizer(voice())).toBe("allow");
    expect(await cedarMediaAuthorizer(voice({ actor: { userId: "u", personId: SENDER, role: "parent" } }))).toBe("allow");
    expect(await cedarMediaAuthorizer(recording())).toBe("allow");
  });
  it("denies a bystander, a circle member, a child reading a parent's recording, and cross-recipient consent", async () => {
    expect(await cedarMediaAuthorizer(voice({ actor: { userId: "u", personId: OTHER, role: "child" } }))).toBe("deny");
    expect(await cedarMediaAuthorizer(voice({ actor: { userId: "u", personId: RECIPIENT, role: "circle" } }))).toBe("deny");
    expect(await cedarMediaAuthorizer(recording({ actor: { userId: "u", personId: OTHER, role: "child" } }))).toBe("deny");
    expect(await cedarMediaAuthorizer(recording({ actor: { userId: "u", personId: SENDER, role: "child" } }))).toBe("deny");
    expect(await cedarMediaAuthorizer(voice({ consent: { ...voice().consent, purpose: `voice_share:${OTHER}` } }))).toBe("deny");
    expect(await cedarMediaAuthorizer(voice({ consent: { ...voice().consent, personId: RECIPIENT } }))).toBe("deny");
  });
  it("denies consent for another call or purpose, and consent granted after now", async () => {
    expect(await cedarMediaAuthorizer(recording({ consent: { ...recording().consent, callId: OTHER } }))).toBe("deny");
    expect(await cedarMediaAuthorizer(recording({ consent: { ...recording().consent, callId: null } }))).toBe("deny");
    expect(await cedarMediaAuthorizer(recording({ consent: { ...recording().consent, purpose: "voice_share:x" } }))).toBe("deny");
    expect(await cedarMediaAuthorizer(recording({ consent: { ...recording().consent, grantedAt: "2026-11-14T10:00:00.001Z" } }))).toBe("deny");
  });
  it("denies expired objects (boundary exclusive) and wrong action", async () => {
    expect(await cedarMediaAuthorizer(voice({ object: { ...voice().object, expiresAt: NOW } }))).toBe("deny");
    expect(await cedarMediaAuthorizer(voice({ action: "read_call_recording" }))).toBe("deny");
  });
  it("denies malformed or missing facts without throwing", async () => {
    for (const ctx of [{} as never, undefined as never, voice({ now: "garbage" }), voice({ familyId: "" }), voice({ action: "other" as never }),
      voice({ subject: { kind: "voice_post", id: POST } }), voice({ actor: { userId: "u", personId: "", role: "child" } })]) {
      expect(await cedarMediaAuthorizer(ctx)).toBe("deny");
    }
  });
});
