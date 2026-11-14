import { createMemoryReplayGuard } from "@/app/api/core1/maa/_lib/device-auth";
import { createSupabaseMaaRepo } from "@/app/api/core1/maa/_lib/supabase-repo";
import { Core2Error, type Core2Person } from "@/lib/core2/contracts";
import { createProductionCore2Deps } from "@/lib/core2/supabase";
import { serviceDatabase } from "@/lib/database";
import type {
  AfterReportDto,
  AfterReportRow,
  AssignmentSummaryRow,
  CircleCompanionCandidate,
  Core2NewsDeps,
  Core2NewsRepository,
  GentleNewsRow,
  HeardMessageKind,
  HeardReceiptRow,
  IncidentSummaryRow,
  MaaQuestionEntry,
  ReassuranceDeliveryRow,
  RecordHeardInput,
  TimelineSummaryRow,
  TwilioOutboxLookup,
  VoicePostDeliveryRow,
  ZapierZ3Status,
} from "./contracts";
import { createDefaultZapierDispatcher } from "./redaction";

const sharedReplayGuard = createMemoryReplayGuard();

function parseQuestions(raw: unknown): MaaQuestionEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item): MaaQuestionEntry => ({
      id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
      question: typeof item.question === "string" ? item.question : "",
      recorded_at: typeof item.recorded_at === "string" ? item.recorded_at : new Date().toISOString(),
      source: item.source === "system" ? "system" : "sarvam_tool",
    }))
    .filter((q) => q.question.length > 0);
}

function mapGentleNewsRow(row: Record<string, unknown>): GentleNewsRow {
  return {
    id: String(row.id),
    family_id: String(row.family_id),
    incident_id: String(row.incident_id),
    subject_person_id: String(row.subject_person_id),
    parent_person_id: String(row.parent_person_id),
    marked_by_person_id: String(row.marked_by_person_id),
    status: row.status as GentleNewsRow["status"],
    calm_summary: String(row.calm_summary),
    voice_post_id: row.voice_post_id ? String(row.voice_post_id) : null,
    circle_person_id: row.circle_person_id ? String(row.circle_person_id) : null,
    circle_offer_status: row.circle_offer_status as GentleNewsRow["circle_offer_status"],
    tried_circle_person_ids: Array.isArray(row.tried_circle_person_ids)
      ? row.tried_circle_person_ids.map(String)
      : [],
    circle_offered_at: row.circle_offered_at ? String(row.circle_offered_at) : null,
    circle_accepted_at: row.circle_accepted_at ? String(row.circle_accepted_at) : null,
    circle_with_maa_at: row.circle_with_maa_at ? String(row.circle_with_maa_at) : null,
    maa_call_due_at: String(row.maa_call_due_at),
    maa_call_outbox_id: row.maa_call_outbox_id ? String(row.maa_call_outbox_id) : null,
    maa_call_queued_at: row.maa_call_queued_at ? String(row.maa_call_queued_at) : null,
    maa_questions: parseQuestions(row.maa_questions),
    raw_event_id: String(row.raw_event_id),
    version: Number(row.version ?? 1),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapHeardReceiptRow(row: Record<string, unknown>): HeardReceiptRow {
  return {
    id: String(row.id),
    family_id: String(row.family_id),
    message_kind: row.message_kind as HeardReceiptRow["message_kind"],
    delivery_id: String(row.delivery_id),
    reassurance_id: row.reassurance_id ? String(row.reassurance_id) : null,
    voice_post_id: row.voice_post_id ? String(row.voice_post_id) : null,
    outbox_id: row.outbox_id ? String(row.outbox_id) : null,
    recipient_person_id: String(row.recipient_person_id),
    channel: row.channel as HeardReceiptRow["channel"],
    evidence_type: row.evidence_type as HeardReceiptRow["evidence_type"],
    device_id: row.device_id ? String(row.device_id) : null,
    call_sid: row.call_sid ? String(row.call_sid) : null,
    clip_duration_s: Number(row.clip_duration_s),
    played_duration_s:
      row.played_duration_s !== null && row.played_duration_s !== undefined
        ? Number(row.played_duration_s)
        : null,
    dtmf_digit: row.dtmf_digit ? String(row.dtmf_digit) : null,
    raw_event_id: String(row.raw_event_id),
    heard_at: String(row.heard_at),
    created_at: String(row.created_at),
  };
}

function mapAfterReportRow(row: Record<string, unknown>): AfterReportRow {
  return {
    id: String(row.id),
    family_id: String(row.family_id),
    incident_id: String(row.incident_id),
    closed_at: String(row.closed_at),
    report_json: row.report_json as AfterReportDto,
    zapier_z3_status: row.zapier_z3_status as ZapierZ3Status,
    zapier_z3_attempted_at: row.zapier_z3_attempted_at ? String(row.zapier_z3_attempted_at) : null,
    zapier_z3_http_status:
      row.zapier_z3_http_status !== null && row.zapier_z3_http_status !== undefined
        ? Number(row.zapier_z3_http_status)
        : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function createSupabaseCore2NewsRepository(): Core2NewsRepository {
  return {
    async getIncident(familyId: string, incidentId: string): Promise<IncidentSummaryRow | null> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("incidents")
        .select("id, family_id, person_id, owner_person_id, state, severity, promised_at, created_at")
        .eq("family_id", familyId)
        .eq("id", incidentId)
        .maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      if (!data) return null;
      return {
        id: String(data.id),
        family_id: String(data.family_id),
        person_id: String(data.person_id),
        owner_person_id: data.owner_person_id ? String(data.owner_person_id) : null,
        state: String(data.state),
        severity: data.severity as IncidentSummaryRow["severity"],
        promised_at: data.promised_at ? String(data.promised_at) : null,
        created_at: String(data.created_at),
      };
    },

    async closeIncident(familyId: string, incidentId: string): Promise<IncidentSummaryRow> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("incidents")
        .update({ state: "closed" })
        .eq("family_id", familyId)
        .eq("id", incidentId)
        .select("id, family_id, person_id, owner_person_id, state, severity, promised_at, created_at")
        .maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      if (!data) throw new Core2Error("not_found", 404, "Incident not found");
      return {
        id: String(data.id),
        family_id: String(data.family_id),
        person_id: String(data.person_id),
        owner_person_id: data.owner_person_id ? String(data.owner_person_id) : null,
        state: String(data.state),
        severity: data.severity as IncidentSummaryRow["severity"],
        promised_at: data.promised_at ? String(data.promised_at) : null,
        created_at: String(data.created_at),
      };
    },

    async getPerson(familyId: string, personId: string): Promise<Core2Person | null> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("people")
        .select("id, family_id, display_name, role, device, timezone")
        .eq("family_id", familyId)
        .eq("id", personId)
        .maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      if (!data) return null;
      return {
        id: String(data.id),
        familyId: String(data.family_id),
        displayName: String(data.display_name),
        role: data.role as Core2Person["role"],
        timezone: String(data.timezone ?? "Asia/Kolkata"),
      };
    },

    async listAssignmentsForIncident(
      familyId: string,
      incidentId: string,
    ): Promise<AssignmentSummaryRow[]> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("assignments")
        .select("id, family_id, incident_id, person_id, status, offered_at, expires_at, accepted_at")
        .eq("family_id", familyId)
        .eq("incident_id", incidentId)
        .order("offered_at", { ascending: true });
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      const rows = data ?? [];
      const personIds = Array.from(new Set(rows.map((r) => String(r.person_id))));
      const personMap = new Map<string, { display_name: string; role: string }>();
      if (personIds.length > 0) {
        const { data: people } = await db
          .from("people")
          .select("id, display_name, role")
          .eq("family_id", familyId)
          .in("id", personIds);
        for (const p of people ?? []) {
          personMap.set(String(p.id), {
            display_name: String(p.display_name),
            role: String(p.role),
          });
        }
      }
      return rows.map((r) => {
        const person = personMap.get(String(r.person_id));
        return {
          id: String(r.id),
          family_id: String(r.family_id),
          incident_id: String(r.incident_id),
          person_id: String(r.person_id),
          display_name: person?.display_name ?? null,
          role: person?.role ?? null,
          status: String(r.status),
          offered_at: String(r.offered_at),
          expires_at: String(r.expires_at),
          accepted_at: r.accepted_at ? String(r.accepted_at) : null,
        };
      });
    },

    async listActiveCircleCompanions(
      familyId: string,
      excludedPersonIds: readonly string[],
    ): Promise<CircleCompanionCandidate[]> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("circle")
        .select("person_id, rank, approved_at, consent_at, revoked_at")
        .eq("family_id", familyId)
        .not("approved_at", "is", null)
        .not("consent_at", "is", null)
        .is("revoked_at", null)
        .order("rank", { ascending: true });
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      const excluded = new Set(excludedPersonIds);
      const active = (data ?? []).filter((c) => !excluded.has(String(c.person_id)));
      if (active.length === 0) return [];

      const { data: people, error: pErr } = await db
        .from("people")
        .select("id, display_name, device")
        .eq("family_id", familyId)
        .in(
          "id",
          active.map((c) => String(c.person_id)),
        );
      if (pErr) throw new Core2Error("storage_unavailable", 503, pErr.message);
      const pMap = new Map(
        (people ?? []).map((p) => [
          String(p.id),
          {
            display_name: String(p.display_name),
            device: (p.device as CircleCompanionCandidate["device"]) ?? null,
          },
        ]),
      );

      return active
        .map((c) => {
          const info = pMap.get(String(c.person_id));
          if (!info) return null;
          return {
            person_id: String(c.person_id),
            display_name: info.display_name,
            device: info.device,
            rank: Number(c.rank),
          };
        })
        .filter((x): x is CircleCompanionCandidate => x !== null);
    },

    async getVoicePost(familyId: string, voicePostId: string): Promise<VoicePostDeliveryRow | null> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("voice_posts")
        .select("id, family_id, sender_id, recipient_id, state, consent_id, created_at")
        .eq("family_id", familyId)
        .eq("id", voicePostId)
        .maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      if (!data) return null;
      return {
        id: String(data.id),
        family_id: String(data.family_id),
        sender_id: String(data.sender_id),
        recipient_id: String(data.recipient_id),
        state: data.state as VoicePostDeliveryRow["state"],
        consent_id: String(data.consent_id),
        created_at: String(data.created_at),
      };
    },

    async getGentleNewsByIncident(
      familyId: string,
      incidentId: string,
    ): Promise<GentleNewsRow | null> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("core2_gentle_news")
        .select("*")
        .eq("family_id", familyId)
        .eq("incident_id", incidentId)
        .maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return data ? mapGentleNewsRow(data as Record<string, unknown>) : null;
    },

    async findLatestOpenGentleNewsForParent(
      familyId: string,
      parentPersonId?: string,
    ): Promise<GentleNewsRow | null> {
      const db = serviceDatabase();
      let q = db
        .from("core2_gentle_news")
        .select("*")
        .eq("family_id", familyId)
        .neq("status", "closed")
        .order("created_at", { ascending: false })
        .limit(1);
      if (parentPersonId) {
        q = q.eq("parent_person_id", parentPersonId);
      }
      const { data, error } = await q.maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return data ? mapGentleNewsRow(data as Record<string, unknown>) : null;
    },

    async insertGentleNews(input): Promise<GentleNewsRow> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("core2_gentle_news")
        .insert({
          family_id: input.familyId,
          incident_id: input.incidentId,
          subject_person_id: input.subjectPersonId,
          parent_person_id: input.parentPersonId,
          marked_by_person_id: input.markedByPersonId,
          status: "circle_offered",
          calm_summary: input.calmSummary,
          voice_post_id: input.voicePostId,
          circle_person_id: input.circlePersonId,
          circle_offer_status: input.circleOfferStatus,
          circle_offered_at: input.circleOfferedAt,
          maa_call_due_at: input.maaCallDueAt,
          raw_event_id: input.rawEventId,
          created_at: input.nowIso,
          updated_at: input.nowIso,
        })
        .select("*")
        .single();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return mapGentleNewsRow(data as Record<string, unknown>);
    },

    async updateGentleNewsCas(
      familyId,
      incidentId,
      expectedVersion,
      patch,
      nowIso,
    ): Promise<GentleNewsRow | null> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("core2_gentle_news")
        .update({
          ...patch,
          version: expectedVersion + 1,
          updated_at: nowIso,
        })
        .eq("family_id", familyId)
        .eq("incident_id", incidentId)
        .eq("version", expectedVersion)
        .select("*")
        .maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return data ? mapGentleNewsRow(data as Record<string, unknown>) : null;
    },

    async listDueGentleNews(nowIso: string, limit: number): Promise<GentleNewsRow[]> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("core2_gentle_news")
        .select("*")
        .in("status", ["circle_offered", "companion_with_maa"])
        .is("maa_call_queued_at", null)
        .lte("maa_call_due_at", nowIso)
        .order("maa_call_due_at", { ascending: true })
        .limit(limit);
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return (data ?? []).map((r) => mapGentleNewsRow(r as Record<string, unknown>));
    },

    async listFamilyTimelineForReport(
      familyId: string,
      _incidentId: string,
    ): Promise<TimelineSummaryRow[]> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("timeline_events")
        .select(
          "id, family_id, event_type, entity_id, human_line, payload_hash, prev_chain_hash, chain_hash, signature, signing_key_id, created_at, sequence, dedupe_key, occurred_at_iso, envelope_canonical",
        )
        .eq("family_id", familyId)
        .order("sequence", { ascending: true });
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return (data ?? []).map((r) => ({
        id: String(r.id),
        family_id: String(r.family_id),
        event_type: String(r.event_type),
        entity_id: r.entity_id ? String(r.entity_id) : null,
        human_line: String(r.human_line),
        payload_hash: String(r.payload_hash),
        prev_chain_hash: r.prev_chain_hash ? String(r.prev_chain_hash) : null,
        chain_hash: String(r.chain_hash),
        signature: String(r.signature),
        signing_key_id: String(r.signing_key_id),
        created_at: String(r.created_at),
        sequence: r.sequence !== null && r.sequence !== undefined ? Number(r.sequence) : null,
        dedupe_key: r.dedupe_key ? String(r.dedupe_key) : null,
        occurred_at_iso: r.occurred_at_iso ? String(r.occurred_at_iso) : null,
        envelope_canonical: r.envelope_canonical ? String(r.envelope_canonical) : null,
      }));
    },

    async listDeliveriesForReport(
      familyId,
      _incidentId,
      subjectPersonId,
      parentPersonId,
      sinceIso,
      untilIso,
    ) {
      const db = serviceDatabase();
      const [{ data: reassurances, error: rErr }, { data: voicePosts, error: vErr }] =
        await Promise.all([
          db
            .from("core2_reassurance_updates")
            .select(
              "id, family_id, subject_person_id, recipient_person_id, kind, watch_id, sos_id, voice_post_id, outbox_id, status_label, delivery_status, delivery_verified, heard_verified, created_at",
            )
            .eq("family_id", familyId)
            .eq("subject_person_id", subjectPersonId)
            .eq("recipient_person_id", parentPersonId)
            .gte("created_at", sinceIso)
            .lte("created_at", untilIso)
            .order("created_at", { ascending: true }),
          db
            .from("voice_posts")
            .select("id, family_id, sender_id, recipient_id, state, consent_id, created_at")
            .eq("family_id", familyId)
            .eq("sender_id", subjectPersonId)
            .eq("recipient_id", parentPersonId)
            .gte("created_at", sinceIso)
            .lte("created_at", untilIso)
            .order("created_at", { ascending: true }),
        ]);
      if (rErr) throw new Core2Error("storage_unavailable", 503, rErr.message);
      if (vErr) throw new Core2Error("storage_unavailable", 503, vErr.message);
      return {
        reassurances: (reassurances ?? []).map((r) => ({
          id: String(r.id),
          family_id: String(r.family_id),
          subject_person_id: String(r.subject_person_id),
          recipient_person_id: String(r.recipient_person_id),
          kind: r.kind as ReassuranceDeliveryRow["kind"],
          watch_id: r.watch_id ? String(r.watch_id) : null,
          sos_id: r.sos_id ? String(r.sos_id) : null,
          voice_post_id: r.voice_post_id ? String(r.voice_post_id) : null,
          outbox_id: r.outbox_id ? String(r.outbox_id) : null,
          status_label: String(r.status_label),
          delivery_status: String(r.delivery_status),
          delivery_verified: Boolean(r.delivery_verified),
          heard_verified: Boolean(r.heard_verified),
          created_at: String(r.created_at),
        })),
        voicePosts: (voicePosts ?? []).map((v) => ({
          id: String(v.id),
          family_id: String(v.family_id),
          sender_id: String(v.sender_id),
          recipient_id: String(v.recipient_id),
          state: v.state as VoicePostDeliveryRow["state"],
          consent_id: String(v.consent_id),
          created_at: String(v.created_at),
        })),
      };
    },

    async listHeardReceiptsByDeliveries(
      familyId: string,
      deliveryIds: readonly string[],
    ): Promise<HeardReceiptRow[]> {
      if (deliveryIds.length === 0) return [];
      const db = serviceDatabase();
      const { data, error } = await db
        .from("core2_heard_receipts")
        .select("*")
        .eq("family_id", familyId)
        .in("delivery_id", [...deliveryIds]);
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return (data ?? []).map((r) => mapHeardReceiptRow(r as Record<string, unknown>));
    },

    async getHeardReceiptByDelivery(
      familyId: string,
      deliveryId: string,
      messageKind?: HeardMessageKind,
    ): Promise<HeardReceiptRow | null> {
      const db = serviceDatabase();
      let q = db
        .from("core2_heard_receipts")
        .select("*")
        .eq("family_id", familyId)
        .eq("delivery_id", deliveryId)
        .order("heard_at", { ascending: false })
        .limit(1);
      if (messageKind) {
        q = q.eq("message_kind", messageKind);
      }
      const { data, error } = await q.maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return data ? mapHeardReceiptRow(data as Record<string, unknown>) : null;
    },

    async findReassurance(
      familyId: string,
      reassuranceId: string,
    ): Promise<ReassuranceDeliveryRow | null> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("core2_reassurance_updates")
        .select(
          "id, family_id, subject_person_id, recipient_person_id, kind, watch_id, sos_id, voice_post_id, outbox_id, status_label, delivery_status, delivery_verified, heard_verified, created_at",
        )
        .eq("family_id", familyId)
        .eq("id", reassuranceId)
        .maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      if (!data) return null;
      return {
        id: String(data.id),
        family_id: String(data.family_id),
        subject_person_id: String(data.subject_person_id),
        recipient_person_id: String(data.recipient_person_id),
        kind: data.kind as ReassuranceDeliveryRow["kind"],
        watch_id: data.watch_id ? String(data.watch_id) : null,
        sos_id: data.sos_id ? String(data.sos_id) : null,
        voice_post_id: data.voice_post_id ? String(data.voice_post_id) : null,
        outbox_id: data.outbox_id ? String(data.outbox_id) : null,
        status_label: String(data.status_label),
        delivery_status: String(data.delivery_status),
        delivery_verified: Boolean(data.delivery_verified),
        heard_verified: Boolean(data.heard_verified),
        created_at: String(data.created_at),
      };
    },

    async resolveTwilioCallContext(
      callSid: string,
      hintFamilyId?: string,
    ): Promise<TwilioOutboxLookup | null> {
      const db = serviceDatabase();
      let q = db
        .from("outbox")
        .select("id, family_id, kind, provider_message_id")
        .eq("provider_message_id", callSid)
        .limit(1);
      if (hintFamilyId) {
        q = q.eq("family_id", hintFamilyId);
      }
      const { data: outbox } = await q.maybeSingle();
      if (!outbox) return null;
      const familyId = String(outbox.family_id);
      const outboxId = String(outbox.id);

      const { data: reassurance } = await db
        .from("core2_reassurance_updates")
        .select("id, recipient_person_id, voice_post_id")
        .eq("family_id", familyId)
        .eq("outbox_id", outboxId)
        .maybeSingle();
      if (reassurance) {
        return {
          family_id: familyId,
          outbox_id: outboxId,
          message_kind: "core2_reassurance",
          delivery_id: String(reassurance.id),
          reassurance_id: String(reassurance.id),
          voice_post_id: reassurance.voice_post_id ? String(reassurance.voice_post_id) : null,
          recipient_person_id: String(reassurance.recipient_person_id),
          clip_duration_s: null,
        };
      }

      const { data: news } = await db
        .from("core2_gentle_news")
        .select("parent_person_id, voice_post_id")
        .eq("family_id", familyId)
        .eq("maa_call_outbox_id", outboxId)
        .maybeSingle();
      if (news) {
        return {
          family_id: familyId,
          outbox_id: outboxId,
          message_kind: "gentle_news_voice",
          delivery_id: outboxId,
          reassurance_id: null,
          voice_post_id: news.voice_post_id ? String(news.voice_post_id) : null,
          recipient_person_id: String(news.parent_person_id),
          clip_duration_s: null,
        };
      }

      return null;
    },

    async recordHeardReceipt(
      input: RecordHeardInput,
    ): Promise<{ receipt: HeardReceiptRow; alreadyRecorded: boolean }> {
      const db = serviceDatabase();
      const { data, error } = await db.rpc("core2_record_heard_receipt", {
        p_family_id: input.familyId,
        p_message_kind: input.messageKind,
        p_delivery_id: input.deliveryId,
        p_reassurance_id: input.reassuranceId,
        p_voice_post_id: input.voicePostId,
        p_outbox_id: input.outboxId,
        p_recipient_person_id: input.recipientPersonId,
        p_channel: input.channel,
        p_evidence_type: input.evidenceType,
        p_device_id: input.deviceId,
        p_call_sid: input.callSid,
        p_clip_duration_s: input.clipDurationS,
        p_played_duration_s: input.playedDurationS,
        p_dtmf_digit: input.dtmfDigit,
        p_raw_event_id: input.rawEventId,
        p_heard_at: input.heardAt,
      });
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      const first = Array.isArray(data) ? data[0] : data;
      const alreadyRecorded = Boolean(first?.already_recorded);
      const { data: row, error: fetchErr } = await db
        .from("core2_heard_receipts")
        .select("*")
        .eq("family_id", input.familyId)
        .eq("message_kind", input.messageKind)
        .eq("delivery_id", input.deliveryId)
        .single();
      if (fetchErr || !row) {
        throw new Core2Error("storage_unavailable", 503, fetchErr?.message ?? "Receipt missing after RPC");
      }
      return {
        receipt: mapHeardReceiptRow(row as Record<string, unknown>),
        alreadyRecorded,
      };
    },

    async getAfterReport(familyId: string, incidentId: string): Promise<AfterReportRow | null> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("core2_after_reports")
        .select("*")
        .eq("family_id", familyId)
        .eq("incident_id", incidentId)
        .maybeSingle();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return data ? mapAfterReportRow(data as Record<string, unknown>) : null;
    },

    async saveAfterReport(input): Promise<AfterReportRow> {
      const db = serviceDatabase();
      const { data, error } = await db
        .from("core2_after_reports")
        .upsert(
          {
            family_id: input.familyId,
            incident_id: input.incidentId,
            closed_at: input.closedAt,
            report_json: input.reportJson,
            zapier_z3_status: input.zapierStatus,
            zapier_z3_attempted_at: input.zapierAttemptedAt,
            zapier_z3_http_status: input.zapierHttpStatus,
            updated_at: input.nowIso,
          },
          { onConflict: "incident_id" },
        )
        .select("*")
        .single();
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
      return mapAfterReportRow(data as Record<string, unknown>);
    },

    async updateAfterReportZapierStatus(
      familyId,
      incidentId,
      status,
      attemptedAt,
      httpStatus,
      nowIso,
    ): Promise<void> {
      const db = serviceDatabase();
      const { error } = await db
        .from("core2_after_reports")
        .update({
          zapier_z3_status: status,
          zapier_z3_attempted_at: attemptedAt,
          zapier_z3_http_status: httpStatus,
          updated_at: nowIso,
        })
        .eq("family_id", familyId)
        .eq("incident_id", incidentId);
      if (error) throw new Core2Error("storage_unavailable", 503, error.message);
    },
  };
}

export function createProductionCore2NewsDeps(): Core2NewsDeps {
  return {
    core2: createProductionCore2Deps(),
    newsRepo: createSupabaseCore2NewsRepository(),
    maaRepo: createSupabaseMaaRepo(),
    replayGuard: sharedReplayGuard,
    zapier: createDefaultZapierDispatcher(),
  };
}
