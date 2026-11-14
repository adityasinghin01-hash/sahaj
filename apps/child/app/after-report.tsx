import React from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Btn, Card, LevelPill, Notice, Screen, Section, T, TopBar } from "../components/sahaj/ui";
import { HeardBadge } from "../components/sahaj/heard-badge";
import { useSession } from "../lib/session";
import {
  closeIncidentAndFetchAfterReport,
  fetchAfterReport,
  fetchGentleNewsState,
  markIncidentHurtGentleNews,
  respondGentleNewsCircleOffer,
  type AfterReport,
  type GentleNewsState,
} from "../lib/core2-news";

function formatClockMs(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export default function AfterReportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ incidentId?: string }>();
  const { session } = useSession();

  const [incidentId, setIncidentId] = React.useState(params.incidentId ?? "");
  const [calmSummary, setCalmSummary] = React.useState(
    "Chhoti chot aayi hai, doctor dekh rahe hain aur sab theek hai.",
  );
  const [gentleNews, setGentleNews] = React.useState<GentleNewsState | null>(null);
  const [report, setReport] = React.useState<AfterReport | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [liveRemainingMs, setLiveRemainingMs] = React.useState<number>(0);

  React.useEffect(() => {
    if (!gentleNews) return;
    setLiveRemainingMs(gentleNews.remaining_ms);
    const timer = setInterval(() => {
      const due = Date.parse(gentleNews.maa_call_due_at);
      if (Number.isFinite(due)) {
        setLiveRemainingMs(Math.max(0, due - Date.now()));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [gentleNews]);

  async function handleStartGentleNews() {
    if (!session || !incidentId.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const state = await markIncidentHurtGentleNews(session, {
        incidentId: incidentId.trim(),
        calmSummary: calmSummary.trim(),
      });
      setGentleNews(state);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Could not stage gentle news");
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshGentleNews() {
    if (!session || !incidentId.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const state = await fetchGentleNewsState(session, incidentId.trim());
      setGentleNews(state);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Could not load gentle news state");
    } finally {
      setBusy(false);
    }
  }

  async function handleCompanionWithMaa() {
    if (!session || !incidentId.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const state = await respondGentleNewsCircleOffer(session, incidentId.trim(), "with_maa");
      setGentleNews(state);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Could not confirm companion with Maa");
    } finally {
      setBusy(false);
    }
  }

  async function handleCloseAndBuildReport() {
    if (!session || !incidentId.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const data = await closeIncidentAndFetchAfterReport(session, incidentId.trim());
      setReport(data);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Could not close incident or build after-report");
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadReport() {
    if (!session || !incidentId.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const data = await fetchAfterReport(session, incidentId.trim());
      setReport(data);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Could not load after-report");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <TopBar title="Gentle News & After-Report" />
      <ScrollView className="flex-1 px-5 pb-12">
        <Notice tone="sand">
          <T v="label">Maa ko achanak bura samachar kabhi seedha nahi jaata</T>
          <T v="small" className="mt-1 text-ink-soft">
            Pehle Core 1 circle companion (jaise Sharma Uncle) ko Maa ke paas baithne ka aagrah jaata hai. Unke &apos;Maa ke paas hoon&apos; kehne par ya samay poora hone par Aasha Didi shaant aawaaz mein baat karti hain.
          </T>
        </Notice>

        <Section title="Incident">
          <Card tone="white">
            <T v="small" className="mb-2 text-ink-soft">
              Incident UUID
            </T>
            <TextInput
              value={incidentId}
              onChangeText={setIncidentId}
              placeholder="xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx"
              autoCapitalize="none"
              className="rounded-xl border border-line bg-paper px-3 py-2.5 text-ink"
            />
            <View className="mt-3 flex-row gap-2">
              <Btn
                label="Load Gentle News"
                kind="soft"
                disabled={busy || !incidentId.trim()}
                onPress={handleRefreshGentleNews}
              />
              <Btn
                label="Load After-Report"
                kind="soft"
                disabled={busy || !incidentId.trim()}
                onPress={handleLoadReport}
              />
            </View>
          </Card>
        </Section>

        {errorMsg ? (
          <View className="mt-4">
            <Notice tone="brand">
              <T v="small">{errorMsg}</T>
            </Notice>
          </View>
        ) : null}

        <Section title="G8 · Stage Gentle News (Hurt / At Hospital)">
          <Card tone="white">
            <T v="small" className="mb-2 text-ink-soft">
              Shaant sandesh (bina kisi darawani detail ya phone number ke)
            </T>
            <TextInput
              value={calmSummary}
              onChangeText={setCalmSummary}
              multiline
              className="min-h-20 rounded-xl border border-line bg-paper px-3 py-2.5 text-ink"
            />
            <View className="mt-4">
              <Btn
                label="Hurt / At Hospital — Circle ko pehle bhejein"
                kind="primary"
                disabled={busy || !incidentId.trim() || !calmSummary.trim()}
                onPress={handleStartGentleNews}
              />
            </View>

            {gentleNews ? (
              <View className="mt-5 border-t border-line pt-4">
                <View className="flex-row items-center justify-between">
                  <LevelPill
                    level={gentleNews.status === "maa_call_queued" ? "green" : "yellow"}
                    label={`Status: ${gentleNews.status}`}
                  />
                  <T v="h3">{formatClockMs(liveRemainingMs)}</T>
                </View>
                <T v="body" className="mt-2">
                  Companion: {gentleNews.circle_display_name ?? "Waiting"} (
                  {gentleNews.circle_offer_status})
                </T>
                <T v="small" className="mt-1 text-ink-soft">
                  Direct push to Maa: Never ({String(gentleNews.maa_notified_via_push)})
                </T>
                {gentleNews.circle_offer_status !== "with_maa" ? (
                  <View className="mt-3">
                    <Btn
                      label="Maa ke paas hoon (Queue calm Aasha Didi call)"
                      kind="teal"
                      disabled={busy}
                      onPress={handleCompanionWithMaa}
                    />
                  </View>
                ) : null}
                {gentleNews.maa_questions.length > 0 ? (
                  <View className="mt-4">
                    <T v="label">Maa ke sawaal (Aasha Didi call se)</T>
                    {gentleNews.maa_questions.map((q) => (
                      <T key={q.id} v="body" className="mt-1">
                        • {q.question}
                      </T>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </Card>
        </Section>

        <Section title="G9 · Close Incident & Redacted After-Report">
          <Card tone="white">
            <Btn
              label="Close Incident & Generate After-Report"
              kind="dark"
              disabled={busy || !incidentId.trim()}
              onPress={handleCloseAndBuildReport}
            />

            {report ? (
              <View className="mt-5 border-t border-line pt-4">
                <View className="flex-row items-center justify-between">
                  <LevelPill
                    level={report.what_happened.timeline_chain_verified ? "green" : "yellow"}
                    label={
                      report.what_happened.timeline_chain_verified
                        ? "Signed Timeline Verified ✓"
                        : "Timeline Unverified"
                    }
                  />
                  <LevelPill
                    level={report.zapier_z3.status === "sent" ? "green" : "yellow"}
                    label={`Zapier Z3: ${report.zapier_z3.status}`}
                  />
                </View>

                <T v="body" className="mt-3">
                  Responder: {report.who_accepted.owner_name ?? "None"} · Resolution:{" "}
                  {report.timings.resolution_duration_s ?? 0}s
                </T>
                <T v="small" className="mt-1 text-ink-soft">
                  Redaction: Phone numbers stripped · Location trail stripped · Real family voice only
                </T>

                <View className="mt-4">
                  <T v="label">Deliveries & Real &quot;Maa Heard It&quot; Proof</T>
                  {report.deliveries.map((d) => (
                    <View
                      key={d.delivery_id}
                      className="mt-2 rounded-xl border border-line bg-paper p-3">
                      <T v="body" className="mb-1.5">
                        {d.label}
                      </T>
                      <HeardBadge
                        heardAt={d.heard_at}
                        heardVerified={d.heard}
                        badgeLabel={d.badge_label}
                        evidenceType={d.heard_evidence}
                      />
                    </View>
                  ))}
                </View>

                <View className="mt-4">
                  <T v="label">Signed Timeline</T>
                  {report.what_happened.timeline_entries.map((entry) => (
                    <T key={entry.id} v="small" className="mt-1 text-ink-soft">
                      • {entry.human_line}
                    </T>
                  ))}
                </View>
              </View>
            ) : null}
          </Card>
        </Section>
      </ScrollView>
    </Screen>
  );
}
