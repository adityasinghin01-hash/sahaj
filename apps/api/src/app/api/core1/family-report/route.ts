import {
  createProductionFamilyReportDeps,
  executeFamilyReportCommand,
} from '@/lib/core1/family-report-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return executeFamilyReportCommand(request, createProductionFamilyReportDeps());
}
