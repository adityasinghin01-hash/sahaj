import { serviceDatabase } from '@/lib/database';
import { handleWeekly } from '@/lib/zapier/weekly';
import { weeklyStore } from '@/lib/zapier/weekly-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const env = process.env;
  return handleWeekly(request, {
    bearer:env.ZAPIER_BEARER ?? '',familyId:env.ZAPIER_WEEKLY_FAMILY_ID ?? '',
    parentId:env.ZAPIER_WEEKLY_PARENT_ID ?? '',requesterId:env.ZAPIER_WEEKLY_REQUESTER_ID ?? '',
  }, () => weeklyStore(serviceDatabase()));
}
