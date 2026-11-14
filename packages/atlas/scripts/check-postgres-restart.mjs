import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { verifiedDatabaseUrl } from './database-url.mjs';

// Synthetic identifiers/enums only. Two child processes prove durable pause/resume.
process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGSMITH_TRACING = 'false';
const [mode, threadId] = process.argv.slice(2);
if (!mode) {
  const thread = `synthetic-restart-${randomUUID()}`;
  for (const step of ['start', 'resume']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), step, thread], {
      env: process.env, encoding: 'utf8', timeout: 60000,
    });
    if (child.status !== 0 || child.stdout.trim() !== `${step}:verified`) {
      console.error(`Postgres restart check failed at ${step}; connection details suppressed.`);
      process.exit(1);
    }
  }
  console.log('Postgres pause/resume verified across two processes; synthetic thread removed.');
} else {
  let saver;
  try {
    if (!process.env.DATABASE_URL || !['start', 'resume'].includes(mode) || !threadId?.startsWith('synthetic-restart-')) throw new Error();
    saver = PostgresSaver.fromConnString(verifiedDatabaseUrl(process.env.DATABASE_URL), { schema: 'sahaj_checkpoints' });
    const state = Annotation.Root({ status: Annotation() });
    const graph = new StateGraph(state).addNode('review', () => {
      const answer = interrupt({ kind: 'synthetic_review' });
      if (answer !== 'approved') throw new Error();
      return { status: 'completed' };
    }).addEdge(START, 'review').addEdge('review', END).compile({ checkpointer: saver });
    const config = { configurable: { thread_id: threadId } };
    if (mode === 'start') {
      await graph.invoke({ status: 'pending' }, config);
      const snapshot = await graph.getState(config);
      if (snapshot.values.status !== 'pending' || !snapshot.next.includes('review')) throw new Error();
    } else {
      const before = await graph.getState(config);
      if (before.values.status !== 'pending' || !before.next.includes('review')) throw new Error();
      const result = await graph.invoke(new Command({ resume: 'approved' }), config);
      if (result.status !== 'completed') throw new Error();
      await saver.deleteThread(threadId);
      if ((await graph.getState(config)).values.status) throw new Error();
    }
    console.log(`${mode}:verified`);
  } catch {
    process.exitCode = 1;
  } finally {
    await saver?.end();
  }
}
