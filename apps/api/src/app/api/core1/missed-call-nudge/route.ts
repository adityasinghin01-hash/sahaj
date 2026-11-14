import {
  createProductionMissedCallNudgeDeps,
  executeMissedCallNudgeCommand,
} from '@/lib/core1/missed-call-nudge-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return executeMissedCallNudgeCommand(request, createProductionMissedCallNudgeDeps());
}
