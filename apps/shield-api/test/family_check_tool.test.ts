import { describe, expect, it } from "vitest";
import { createSarvamToolHandler } from "@/lib/handlers";
import { parseFamilyCheckToolBody, type ResponderAnswerInput } from "@/lib/sarvam_family_check";
import type { ShieldApp } from "@/lib/app";

const FAM = "11111111-1111-4111-8111-111111111111";
const ROHIT = "22222222-2222-4222-8222-222222222222";
const CHECK = "33333333-3333-4333-8333-333333333333";
const RECEIPT = "44444444-4444-4444-8444-444444444444";

function app(receipt: string | null, result: "recorded" | "no_open_check" = "recorded") {
  const calls: ResponderAnswerInput[] = [];
  const a = {
    env: { SARVAM_TOOL_TOKEN: "t".repeat(32), ALLOW_ANY_TOOL_IP: "1" },
    sarvamFamilyCheckStore: {
      findResponderReceipt: async (f: string, c: string) => (f === FAM && c === CHECK ? receipt : null),
      recordResponderAnswer: async (i: ResponderAnswerInput) => { calls.push(i); return result; },
    },
  } as unknown as ShieldApp;
  return { a, calls };
}
const post = (body: unknown, token = "t".repeat(32)) => new Request("http://x/api/sarvam/tool/family_check_answer", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const route = { params: Promise.resolve({ name: "family_check_answer" }) };

describe("family_check_answer tool (responder agent)", () => {
  it("parses ids + haan/nahi and refuses junk", () => {
    expect(parseFamilyCheckToolBody({ family_id: FAM, person_id: ROHIT, check_id: CHECK, answer: "haan" })?.answer).toBe("confirmed");
    expect(parseFamilyCheckToolBody({ family_id: FAM, person_id: ROHIT, incident_id: CHECK, answer: "nahi" })?.answer).toBe("denied");
    expect(parseFamilyCheckToolBody({ family_id: FAM, person_id: ROHIT, check_id: CHECK, answer: "maybe" })).toBeNull();
    expect(parseFamilyCheckToolBody({ family_id: "x", person_id: ROHIT, check_id: CHECK, answer: "haan" })).toBeNull();
  });
  it("records against OUR responder call for that check", async () => {
    const { a, calls } = app(RECEIPT);
    const res = await createSarvamToolHandler(() => a)(post({ family_id: FAM, person_id: ROHIT, check_id: CHECK, answer: "nahi" }), route);
    const json = await res.json();
    expect(json.status).toBe("recorded");
    expect(json.transfer).toBe(false);
    expect(calls[0]).toMatchObject({ familyId: FAM, personId: ROHIT, checkId: CHECK, receiptId: RECEIPT, answer: "denied" });
  });
  it("no responder call placed by us -> refused + transfer, nothing recorded", async () => {
    const { a, calls } = app(null);
    const json = await (await createSarvamToolHandler(() => a)(post({ family_id: FAM, person_id: ROHIT, check_id: CHECK, answer: "haan" }), route)).json();
    expect(json).toMatchObject({ status: "no_responder_call", transfer: true });
    expect(calls).toHaveLength(0);
  });
  it("closed/foreign check -> transfer", async () => {
    const { a } = app(RECEIPT, "no_open_check");
    const json = await (await createSarvamToolHandler(() => a)(post({ family_id: FAM, person_id: ROHIT, check_id: CHECK, answer: "haan" }), route)).json();
    expect(json).toMatchObject({ status: "no_open_check", transfer: true });
  });
  it("wrong bearer -> 401", async () => {
    const { a } = app(RECEIPT);
    expect((await createSarvamToolHandler(() => a)(post({}, "bad"), route)).status).toBe(401);
  });
});
