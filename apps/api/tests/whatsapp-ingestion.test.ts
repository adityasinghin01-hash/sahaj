import { expect, it, vi } from "vitest";
import { ingestWhatsApp } from "../src/lib/whatsapp-ingestion";
import { WebhookError } from "../src/lib/webhook-security";

const fixture = (messages: unknown[]) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "demo-account" }, messages } }] }] });
const message = (from: string) => ({ id: `demo-${from}`, from, type: "text", text: { body: "Synthetic greeting" } });
const store = () => ({ resolve: vi.fn(async () => ({ familyId: "family-a", personId: "person-a" })), ingest: vi.fn(async () => {}) });

it("validates provider account before identity lookup or persistence", async () => {
  const db = store();
  await expect(ingestWhatsApp(fixture([message("parent-demo")]), "other", db)).rejects.toMatchObject({ status: 403 });
  expect(db.resolve).not.toHaveBeenCalled();
  expect(db.ingest).not.toHaveBeenCalled();
});
it("checks every sender before accepting a batch", async () => {
  const db = store();
  db.resolve.mockRejectedValueOnce(new WebhookError("unregistered_sender", 403));
  await expect(ingestWhatsApp(fixture([message("unknown")]), "demo-account", db)).rejects.toMatchObject({ status: 403 });
  expect(db.ingest).not.toHaveBeenCalled();
});
it("acknowledges only after every event has been durably persisted", async () => {
  const db = store();
  db.ingest.mockRejectedValueOnce(new WebhookError("event_persistence_failed", 503));
  await expect(ingestWhatsApp(fixture([message("parent-demo")]), "demo-account", db)).rejects.toMatchObject({ status: 503 });
});
it("persists isolated event payloads without copying another family's batch", async () => {
  const db = store();
  expect(await ingestWhatsApp(fixture([message("parent-demo")]), "demo-account", db)).toBe(1);
  expect(db.ingest).toHaveBeenCalledWith(expect.objectContaining({ id: "demo-account:demo-parent-demo", familyId: "family-a", payload: { account: "demo-account", event: message("parent-demo") } }));
});
it("rejects malformed and empty envelopes", async () => {
  await expect(ingestWhatsApp(null, "demo-account", store())).rejects.toMatchObject({ status: 400 });
  await expect(ingestWhatsApp(fixture([]), "demo-account", store())).rejects.toMatchObject({ status: 400 });
});
