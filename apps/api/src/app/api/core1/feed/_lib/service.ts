import { NextResponse } from 'next/server';
import {
  Core1CommandError,
  createDefaultAuthPort,
  createSupabaseCore1Repository,
  isValidUuid,
  mapToCommandError,
} from '@/lib/core1';
import { serviceDatabase } from '@/lib/database';
import { bearerToken } from '@/lib/secrets';
import { createSupabaseCore1FeedRepository } from './supabase-repo';
import type {
  AuthenticatedFeedActor,
  CheckInsFeedResponse,
  Core1FeedPorts,
  IncidentsFeedResponse,
  RefillsFeedResponse,
  VoiceFeedResponse,
} from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

export function createDefaultCore1FeedPorts(): Core1FeedPorts {
  const client = serviceDatabase();
  return {
    auth: createDefaultAuthPort(),
    membershipRepo: createSupabaseCore1Repository(client),
    feedRepo: createSupabaseCore1FeedRepository(client),
  };
}

/**
 * Redacts any accidental 4+ digit numeric sequences (phone numbers, OTPs) from free text.
 */
export function sanitizeSummaryText(text: string): string {
  return text
    .replace(/\+?\d[\d\s-]{6,}\d/g, '<MOBILE_10>')
    .replace(/\b\d{4,}\b/g, '******')
    .trim();
}

function parseLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get('limit');
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new Core1CommandError('invalid_limit', 400);
  }
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) {
    throw new Core1CommandError('invalid_limit', 400);
  }
  return n;
}

function extractRequestedFamilyId(request: Request): string | undefined {
  const url = new URL(request.url);
  const queryFamilyId =
    url.searchParams.get('familyId')?.trim() ??
    url.searchParams.get('family_id')?.trim();
  const headerFamilyId = request.headers.get('x-sahaj-family-id')?.trim();

  if (queryFamilyId && headerFamilyId && queryFamilyId !== headerFamilyId) {
    throw new Core1CommandError('conflicting_family_id', 400);
  }

  const candidate = queryFamilyId || headerFamilyId || undefined;
  if (candidate !== undefined && !isValidUuid(candidate)) {
    throw new Core1CommandError('invalid_family_id_uuid', 400);
  }
  return candidate;
}

export async function authenticateFeedActor(
  request: Request,
  ports: Core1FeedPorts
): Promise<AuthenticatedFeedActor> {
  const token = bearerToken(request);
  if (!token) {
    throw new Core1CommandError('unauthorized_missing_bearer_token', 401);
  }

  let user;
  try {
    user = await ports.auth.getUser(token);
  } catch {
    throw new Core1CommandError('unauthorized_invalid_bearer_token', 401);
  }

  if (!user || !user.id) {
    throw new Core1CommandError('unauthorized_invalid_bearer_token', 401);
  }

  const requestedFamilyId = extractRequestedFamilyId(request);
  const membership = await ports.membershipRepo.getMembership(user.id, requestedFamilyId);

  if (membership.role === 'circle') {
    const circle = await ports.membershipRepo.getCircleRecord(
      membership.familyId,
      membership.personId
    );
    if (!circle) {
      throw new Core1CommandError('circle_record_missing_fail_closed', 403);
    }
    if (!circle.active) {
      throw new Core1CommandError('circle_member_inactive', 403);
    }
    if (circle.revokedAt) {
      throw new Core1CommandError('circle_member_revoked', 403);
    }
    if (!circle.consentAt) {
      throw new Core1CommandError('circle_member_missing_consent', 403);
    }
  } else if (membership.role !== 'child' && membership.role !== 'parent') {
    throw new Core1CommandError('unrecognized_role_fail_closed', 403);
  }

  return {
    userId: user.id,
    membership,
    role: membership.role,
  };
}

export async function getVoiceFeed(
  request: Request,
  ports: Core1FeedPorts
): Promise<VoiceFeedResponse> {
  const actor = await authenticateFeedActor(request, ports);
  if (actor.role !== 'parent' && actor.role !== 'child') {
    throw new Core1CommandError('circle_role_unauthorized_for_voice_feed', 403);
  }
  const limit = parseLimit(request);
  const items = await ports.feedRepo.listVoicePosts(
    actor.membership.familyId,
    actor.membership.personId,
    limit
  );
  return {
    family_id: actor.membership.familyId,
    caller_person_id: actor.membership.personId,
    items,
  };
}

export async function getIncidentsFeed(
  request: Request,
  ports: Core1FeedPorts
): Promise<IncidentsFeedResponse> {
  const actor = await authenticateFeedActor(request, ports);
  const limit = parseLimit(request);
  const items = await ports.feedRepo.listIncidents(actor.membership.familyId, limit);
  return {
    family_id: actor.membership.familyId,
    items,
  };
}

export async function getRefillsFeed(
  request: Request,
  ports: Core1FeedPorts
): Promise<RefillsFeedResponse> {
  const actor = await authenticateFeedActor(request, ports);
  if (actor.role !== 'parent' && actor.role !== 'child') {
    throw new Core1CommandError('circle_role_unauthorized_for_refills_feed', 403);
  }
  const limit = parseLimit(request);
  const items = await ports.feedRepo.listRefills(actor.membership.familyId, limit);
  return {
    family_id: actor.membership.familyId,
    items,
  };
}

export async function getCheckInsFeed(
  request: Request,
  ports: Core1FeedPorts
): Promise<CheckInsFeedResponse> {
  const actor = await authenticateFeedActor(request, ports);
  if (actor.role !== 'parent' && actor.role !== 'child') {
    throw new Core1CommandError('circle_role_unauthorized_for_checkins_feed', 403);
  }
  const limit = parseLimit(request);
  const restrictToPersonId =
    actor.role === 'parent' ? actor.membership.personId : undefined;
  const result = await ports.feedRepo.listCheckIns(
    actor.membership.familyId,
    restrictToPersonId,
    limit
  );
  return {
    family_id: actor.membership.familyId,
    ...result,
  };
}

export async function handleCore1FeedRoute<T>(
  request: Request,
  run: (ports: Core1FeedPorts, req: Request) => Promise<T>,
  portsOverride?: Core1FeedPorts
): Promise<Response> {
  try {
    const ports = portsOverride ?? createDefaultCore1FeedPorts();
    const body = await run(ports, request);
    return NextResponse.json(body, { status: 200, headers: RESPONSE_HEADERS });
  } catch (error) {
    const mapped =
      error instanceof Core1CommandError ? error : mapToCommandError(error);
    const headers =
      mapped.status === 401
        ? { ...RESPONSE_HEADERS, 'www-authenticate': 'Bearer' }
        : RESPONSE_HEADERS;
    return NextResponse.json(
      { error: mapped.code },
      { status: mapped.status, headers }
    );
  }
}
