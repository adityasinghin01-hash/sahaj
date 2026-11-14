import {
  createProductionFamilyReportDeps,
  executeWeeklyFamilyReportZapierGet,
} from '@/lib/core1/family-report-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const deps = createProductionFamilyReportDeps();
  return executeWeeklyFamilyReportZapierGet(request, {
    store: deps.store,
    env: deps.env,
  });
}

