import { createHash } from 'node:crypto';
import { Annotation, Command, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { evaluateGate, type GateAction, type GateDecision, type GateInput } from '@sahaj/gate';

export interface JobScope { familyId: string; jobId: string }
/** Trusted server record. Payload and transcripts stay in protected event storage. */
export interface AtlasJob extends JobScope { eventId: string; actorId: string; requestId: string; targetId: string }
export type Understanding = { action: GateAction | 'unknown'; certainty: 'ready' | 'uncertain' };
export interface OutboxCommand extends JobScope { eventId: string; action: GateAction; idempotencyKey: string }
export type EnqueueResult = { status: 'enqueued'; outboxId: string } | { status: 'review' | 'denied' };
export type DeliveryObservation = { verified: boolean; status: 'pending' | 'delivered' | 'failed'; responderAccepted: boolean };
export type AtlasStatus = 'loaded' | 'review' | 'authorized' | 'denied' | 'queued' | 'waiting' | 'delivered' | 'accepted' | 'failed';
export interface AtlasPorts {
  loadJob(scope: JobScope): Promise<AtlasJob>;
  /** LLM/provider understanding occurs here; return only this small enum projection. */
  understand(job: AtlasJob): Promise<Understanding>;
  loadGateInput(job: AtlasJob, action: GateAction): Promise<GateInput>;
  /** Must atomically REAUTHORIZE, reserve usage, consume approvals, and insert unique outbox key. */
  enqueueAuthorized(command: OutboxCommand): Promise<EnqueueResult>;
  /** Read verified, persisted provider events; never infer delivery/acceptance from enqueue. */
  observeDelivery(scope: JobScope, outboxId: string): Promise<DeliveryObservation>;
  /** Must append an actual signed timeline entry with a unique idempotency key. */
  appendSignedOutcome(entry: JobScope & { eventId: string; status: 'denied' | 'delivered' | 'accepted' | 'failed'; idempotencyKey: string }): Promise<void>;
  /** Cross-process job lock/lease, not a process-local lock in production. */
  withJobLock<T>(scope: JobScope, work: () => Promise<T>): Promise<T>;
}

const State = Annotation.Root({
  familyId: Annotation<string>, jobId: Annotation<string>, eventId: Annotation<string>,
  action: Annotation<GateAction | 'unknown'>, certainty: Annotation<'ready' | 'uncertain'>,
  status: Annotation<AtlasStatus>, outboxId: Annotation<string>,
});
type WorkflowState = typeof State.State;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowed = new Set<GateAction>(['check_in', 'urgent_responder', 'voice_message', 'medicine_refill',
  'missed_call_nudge', 'send_alert', 'family_report', 'record_audio', 'share_data']);
const prohibited = new Set(['payment', 'collect_otp', 'medical_diagnosis']);
function assertScope(scope: JobScope): void {
  if (!scope || !uuid.test(scope.familyId) || !uuid.test(scope.jobId)) throw new Error('Invalid Atlas scope');
}
export function atlasThreadId(scope: JobScope): string {
  assertScope(scope);
  return `atlas:v1:${createHash('sha256').update(JSON.stringify([scope.familyId, scope.jobId])).digest('hex')}`;
}
function key(scope: JobScope, suffix: string): string { return `${atlasThreadId(scope)}:${suffix}`; }

export function createAtlas(ports: AtlasPorts, checkpointer: BaseCheckpointSaver) {
  async function safe<T>(operation: () => Promise<T>, label: string): Promise<T> {
    try { return await operation(); } catch { throw new Error(`Atlas ${label} failed`); }
  }
  async function load(scope: JobScope): Promise<AtlasJob> {
    assertScope(scope);
    const job = await safe(() => ports.loadJob({ familyId: scope.familyId, jobId: scope.jobId }), 'job load');
    if (!job || job.familyId !== scope.familyId || job.jobId !== scope.jobId ||
      ![job.eventId, job.actorId, job.requestId, job.targetId].every(id => typeof id === 'string' && uuid.test(id))) {
      throw new Error('Atlas job scope mismatch');
    }
    return job;
  }
  async function authorize(state: WorkflowState): Promise<GateDecision> {
    if (!allowed.has(state.action as GateAction)) return { decision: 'deny', reason: 'prohibited_action' };
    const job = await load(state);
    const input = await safe(() => ports.loadGateInput(job, state.action as GateAction), 'permission load');
    if (input.actor.id !== job.actorId || input.actor.familyId !== job.familyId ||
      input.request.familyId !== job.familyId || input.request.id !== job.requestId ||
      input.request.targetId !== job.targetId || input.request.action !== state.action) throw new Error('Atlas authorization scope mismatch');
    return evaluateGate(input);
  }
  const graph = new StateGraph(State)
    .addNode('load', async state => ({ eventId: (await load(state)).eventId, status: 'loaded' as const }))
    .addNode('understand', async state => {
      const job = await load(state);
      const result = await safe(() => ports.understand(job), 'understanding');
      // Discard every field except known enums, including accidental transcripts.
      const action = result && (allowed.has(result.action as GateAction) || prohibited.has(result.action)) ? result.action : 'unknown';
      const certainty = result?.certainty === 'ready' ? 'ready' : 'uncertain';
      return { action, certainty };
    })
    .addNode('guard', async state => {
      if (prohibited.has(state.action)) return { status: 'denied' as const };
      if (state.action === 'unknown' || state.certainty !== 'ready') return { status: 'review' as const };
      const decision = await authorize(state);
      return { status: decision.decision === 'allow' ? 'authorized' as const : decision.decision === 'ask' ? 'review' as const : 'denied' as const };
    })
    .addNode('review', state => {
      // This is a wake-up signal only. Approval facts are reloaded from the DB.
      interrupt({ kind: 'review_required', familyId: state.familyId, jobId: state.jobId });
      return { status: 'loaded' as const };
    })
    .addNode('enqueue', async state => {
      // Port must first recover an existing idempotent outbox row; otherwise it
      // reauthorizes and reserves usage atomically. Rechecking outside that
      // transaction could reject recovery after the first attempt consumed quota.
      const job = await load(state);
      const result = await safe(() => ports.enqueueAuthorized({ familyId: state.familyId, jobId: state.jobId,
        eventId: job.eventId, action: state.action as GateAction, idempotencyKey: key(state, 'outbox:v1') }), 'outbox write');
      if (result.status !== 'enqueued') return { status: result.status === 'review' ? 'review' as const : 'denied' as const };
      if (!uuid.test(result.outboxId)) throw new Error('Invalid Atlas outbox reference');
      return { outboxId: result.outboxId, status: 'queued' as const };
    })
    .addNode('observe', async state => {
      await load(state);
      const observation = await safe(() => ports.observeDelivery({ familyId: state.familyId, jobId: state.jobId }, state.outboxId), 'delivery load');
      if (!observation || observation.verified !== true || !['pending', 'delivered', 'failed'].includes(observation.status)) return { status: 'waiting' as const };
      if (observation.status === 'failed') return { status: 'failed' as const };
      if (observation.status !== 'delivered') return { status: 'waiting' as const };
      if (state.action === 'urgent_responder') return { status: observation.responderAccepted === true ? 'accepted' as const : 'waiting' as const };
      return { status: 'delivered' as const };
    })
    .addNode('wait', state => {
      interrupt({ kind: 'delivery_pending', familyId: state.familyId, jobId: state.jobId, outboxId: state.outboxId });
      return { status: 'waiting' as const };
    })
    .addNode('sign', async state => {
      await load(state);
      if (!['denied', 'delivered', 'accepted', 'failed'].includes(state.status)) throw new Error('Invalid Atlas terminal state');
      await safe(() => ports.appendSignedOutcome({ familyId: state.familyId, jobId: state.jobId, eventId: state.eventId,
        status: state.status as 'denied' | 'delivered' | 'accepted' | 'failed', idempotencyKey: key(state, `timeline:${state.status}:v1`) }), 'timeline append');
      return {};
    })
    .addEdge(START, 'load').addEdge('load', 'understand').addEdge('understand', 'guard')
    .addConditionalEdges('guard', state => state.status === 'authorized' ? 'enqueue' : state.status === 'review' ? 'review' : 'sign')
    .addEdge('review', 'load')
    .addConditionalEdges('enqueue', state => state.status === 'queued' ? 'observe' : state.status === 'review' ? 'review' : 'sign')
    .addConditionalEdges('observe', state => state.status === 'waiting' ? 'wait' : 'sign')
    .addEdge('wait', 'observe').addEdge('sign', END)
    .compile({ checkpointer });

  const config = (scope: JobScope) => ({ configurable: { thread_id: atlasThreadId(scope) }, recursionLimit: 100 });
  async function start(scope: JobScope) {
    assertScope(scope);
    return ports.withJobLock(scope, async () => {
      await load(scope); // Verify persisted family ownership before reading the checkpoint.
      const existing = await graph.getState(config(scope));
      if (existing.values && Object.keys(existing.values).length) return existing;
      await graph.invoke({ familyId: scope.familyId, jobId: scope.jobId }, config(scope));
      return graph.getState(config(scope));
    });
  }
  async function resume(scope: JobScope) {
    assertScope(scope);
    return ports.withJobLock(scope, async () => {
      await load(scope);
      const snapshot = await graph.getState(config(scope));
      if (!snapshot.values || !Object.keys(snapshot.values).length) throw new Error('Atlas thread not started');
      if (snapshot.values.familyId !== scope.familyId || snapshot.values.jobId !== scope.jobId) throw new Error('Atlas checkpoint scope mismatch');
      if (!snapshot.next.length) return snapshot;
      const interrupted = snapshot.tasks.some(task => task.interrupts?.length);
      await graph.invoke(interrupted ? new Command({ resume: { wake: true } }) : null, config(scope));
      return graph.getState(config(scope));
    });
  }
  return { start, resume };
}
