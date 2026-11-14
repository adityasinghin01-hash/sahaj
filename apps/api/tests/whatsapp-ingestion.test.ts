import { expect, it, vi } from "vitest";
import { ingestWhatsApp } from "../src/lib/whatsapp-ingestion";
import { WebhookError } from "../src/lib/webhook-security";

const fixture = (messages: unknown[]) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "demo-account" }, messages } }] }] });
const message = (from: string) => ({ id: `demo-${from}`, from, type: "text", text: { body: "Synthetic greeting" } });
const store = () => ({
  resolve: vi.fn(async () => ({ familyId: "family-a", personId: "person-a" })),
  findMessageBinding: vi.fn(async (): Promise<{ familyId: string; personId: string } | null> => ({ familyId: "family-a", personId: "person-a" })),
  ingest: vi.fn(async (_e: unknown) => {}),
});

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

const statusFixture = (statuses: unknown[], account = "demo-account") => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: account }, statuses } }] }] });
const status = (o: Record<string, unknown> = {}) => ({ id: "wamid.SYN1", recipient_id: "919000000001", status: "delivered", timestamp: "1794000000", ...o });
const stored = (db: ReturnType<typeof store>, i = 0) => db.ingest.mock.calls[i]![0] as { metadata?: Record<string, string>; type: string; id: string };

it("attaches status and provider_ref only when this account sent that message to this same person", async () => {
  const db = store();
  await ingestWhatsApp(statusFixture([status()]), "demo-account", db);
  expect(db.findMessageBinding).toHaveBeenCalledWith("demo-account", "wamid.SYN1");
  expect(stored(db)).toMatchObject({ type: "whatsapp.status", id: "demo-account:wamid.SYN1:delivered:1794000000", metadata: { status: "delivered", provider_ref: "wamid.SYN1" } });
});
it("a status naming another recipient than the one the message was sent to is stored raw and unprovable", async () => {
  for (const sent of [{ familyId: "family-a", personId: "person-b" }, { familyId: "family-b", personId: "person-a" }, null]) {
    const db = store(); db.findMessageBinding.mockResolvedValueOnce(sent);
    await ingestWhatsApp(statusFixture([status()]), "demo-account", db);
    expect(stored(db).metadata).toEqual({ status: "delivered", binding: "unverified" });
  }
});
it("unknown statuses never become a proof-capable status", async () => {
  for (const s of ["deleted", "warning", "DELIVERED", "played"]) {
    const db = store();
    await ingestWhatsApp(statusFixture([status({ status: s })]), "demo-account", db);
    expect(stored(db).metadata?.status).toBe("unsupported");
  }
});
it("a status from another business account is refused before any lookup", async () => {
  const db = store();
  await expect(ingestWhatsApp(statusFixture([status()], "other-account"), "demo-account", db)).rejects.toMatchObject({ status: 403 });
  expect(db.findMessageBinding).not.toHaveBeenCalled(); expect(db.ingest).not.toHaveBeenCalled();
});
it("text messages are unchanged: no status metadata and no message lookup", async () => {
  const db = store();
  await ingestWhatsApp(fixture([message("parent-demo")]), "demo-account", db);
  expect(stored(db).metadata).toBeUndefined(); expect(db.findMessageBinding).not.toHaveBeenCalled();
});
it("a status without recipient_id (BSUID-only user) is attributed through our own message binding, or refused", async () => {
  const db = store();
  const { recipient_id: _drop, ...noRecipient } = status();
  await ingestWhatsApp(statusFixture([{ ...noRecipient, recipient_user_id: "US.123" }]), "demo-account", db);
  expect(db.resolve).not.toHaveBeenCalled();
  expect(stored(db)).toMatchObject({ metadata: { status: "delivered", provider_ref: "wamid.SYN1" } });
  const none = store(); none.findMessageBinding.mockResolvedValue(null);
  await expect(ingestWhatsApp(statusFixture([noRecipient]), "demo-account", none)).rejects.toMatchObject({ status: 403 });
  expect(none.ingest).not.toHaveBeenCalled();
});