import { errorJsonResponse, handleMaaUrgentCreate } from '../_lib/service';
import { createSupabaseMaaRepo } from '../_lib/supabase-repo';
import {
  createProductionUrgentHelpDeps,
  dispatchUrgentCallAndPushForIncident,
} from '@/lib/core1/urgent-help-service';

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleMaaUrgentCreate(request, {
      repo: createSupabaseMaaRepo(),
      onUrgentIncidentCreated: async (event) => {
        const offeredAssignment = event.assignments.find((a) => a.state === 'offered') ?? event.assignments[0] ?? null;
        await dispatchUrgentCallAndPushForIncident(createProductionUrgentHelpDeps(), {
          familyId: event.familyId,
          incidentId: event.incidentId,
          subjectPersonId: event.subjectPersonId,
          severity: event.severity,
          assignmentId: offeredAssignment?.id ?? null,
          responderPersonId: offeredAssignment?.assigneePersonId ?? null,
          state: event.state,
        });
      },
    });
  } catch (err) {
    return errorJsonResponse(err);
  }
}
