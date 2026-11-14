import { describe, expect, it } from "vitest";
import { ShieldEvent } from "@sahaj/shared";
import { evaluateRules } from "../../src/runtime/rules";

let n = 0;
function ev(partial: Partial<ShieldEvent> & Pick<ShieldEvent, "kind">): ShieldEvent {
  n += 1;
  return ShieldEvent.parse({
    idempotency_key: `phase2-bridge-${n}-xxxxxxxx`, family_id: "fam-1", parent_id: "maa-1",
    channel: "device", occurred_at: "2026-11-14T13:00:00.000Z", ...partial,
  });
}

const fired = (event: ShieldEvent, recent: ShieldEvent[] = []) => evaluateRules(event, recent).verdict;

describe("runtime rules bridge: Phase 2 live telemetry reaches the Phase 2 rules", () => {
  it("P9: banking app opened while the phone says it is on an unsaved call → red", () => {
    const v = fired(ev({ kind: "app_open", context: { package: "com.phonepe.app", on_call_with_unsaved: true } }));
    expect(v.level).toBe("red");
    expect(v.checks_fired).toContain("pattern.P9");
  });

  it("P9: banking app with no call → not P9", () => {
    const v = fired(ev({ kind: "app_open", context: { package: "com.phonepe.app" } }));
    expect(v.checks_fired).not.toContain("pattern.P9");
  });

  it("P9: an earlier, ended call does not hide the phone's live on-call flag", () => {
    const oldCall = ev({ kind: "call_state", caller_type: "mobile_10", occurred_at: "2026-11-14T12:00:00.000Z",
      context: { call_started_at: "2026-11-14T12:00:00.000Z", call_ended_at: "2026-11-14T12:05:00.000Z" } });
    const v = fired(ev({ kind: "app_open", context: { package: "com.phonepe.app", on_call_with_unsaved: true } }), [oldCall]);
    expect(v.checks_fired).toContain("pattern.P9");
  });

  it("P2: WhatsApp call notification from an unsaved number running 10+ minutes → red", () => {
    const v = fired(ev({ kind: "notification", context: { source: "whatsapp", whatsapp_call_unsaved: true, call_seconds: 660 } }));
    expect(v.level).toBe("red");
    expect(v.checks_fired).toContain("pattern.P2");
  });

  it("P2: the same notification at 5 minutes → not P2", () => {
    const v = fired(ev({ kind: "notification", context: { source: "whatsapp", whatsapp_call_unsaved: true, call_seconds: 300 } }));
    expect(v.checks_fired).not.toContain("pattern.P2");
  });

  it("P3: .apk attachment notification → red", () => {
    const v = fired(ev({ kind: "notification", context: { source: "whatsapp", attachment_apk: true } }));
    expect(v.level).toBe("red");
    expect(v.checks_fired).toContain("pattern.P3");
  });

  it("P3: app installed outside the Play Store 2 h ago (hours sent by phone) → red", () => {
    const v = fired(ev({ kind: "install", context: { package: "com.example.wedding", installer: "com.whatsapp", installed_hours_ago: 2 } }));
    expect(v.checks_fired).toContain("pattern.P3");
  });

  it("P3: install age computed from first_install_ms when hours are not sent", () => {
    const at = Date.parse("2026-11-14T13:00:00.000Z");
    const v = fired(ev({ kind: "install", context: { package: "com.example.wedding", installer: "com.whatsapp", first_install_ms: at - 3 * 3_600_000 } }));
    expect(v.checks_fired).toContain("pattern.P3");
  });

  it("P3: Play Store install → not P3", () => {
    const v = fired(ev({ kind: "install", context: { package: "com.example.app", installer: "com.android.vending", installed_hours_ago: 1 } }));
    expect(v.checks_fired).not.toContain("pattern.P3");
  });

  it("P4: remote-control app installed → red", () => {
    const v = fired(ev({ kind: "install", context: { package: "com.anydesk.anydeskandroid", installer: "com.android.vending", installed_hours_ago: 1 } }));
    expect(v.level).toBe("red");
    expect(v.checks_fired).toContain("pattern.P4");
  });

  it("an earlier red install does not re-fire on a later clean event", () => {
    const badInstall = ev({ kind: "install", occurred_at: "2026-11-14T12:50:00.000Z",
      context: { package: "com.anydesk.anydeskandroid", installer: "com.android.vending", installed_hours_ago: 1 } });
    const v = fired(ev({ kind: "app_open", context: { package: "com.whatsapp" } }), [badInstall]);
    expect(v.level).toBe("green");
    expect(v.checks_fired).not.toContain("pattern.P4");
  });

  it("client claims (local_level / matched_rules) cannot make a clean event red", () => {
    const v = fired(ev({ kind: "app_open", local_level: "red", matched_rules: ["pattern.P9"], context: { package: "com.whatsapp" } }));
    expect(v.level).toBe("green");
  });

  it("Phase 1 still works: OTP SMS during an unknown call → P1 red", () => {
    const call = ev({ kind: "call_state", caller_type: "mobile_10", occurred_at: "2026-11-14T12:58:00.000Z",
      context: { call_started_at: "2026-11-14T12:58:00.000Z" } });
    const sms = ev({ kind: "sms", sender_type: "business_header", masked_text: "Your OTP is ****** . Do not share it with anyone.",
      context: { on_call_with_unsaved: true } });
    const v = fired(sms, [call]);
    expect(v.level).toBe("red");
    expect(v.checks_fired).toContain("pattern.P1");
  });
});
