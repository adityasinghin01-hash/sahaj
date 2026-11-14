import type {
  ConsentRow,
  MediaAuthorizationContext,
  StorageSigner,
  VoiceContentRow,
} from '@/lib/media/contracts';

export type MaaUrgentState = 'open' | 'offered' | 'accepted' | 'escalated' | 'resolved' | 'cancelled';
export type MaaAssignmentState = 'offered' | 'accepted' | 'declined' | 'expired' | 'completed';
export type MaaVoiceState = 'queued' | 'sent' | 'delivered' | 'heard' | 'failed';

export interface MaaDeviceRecord {
  deviceId: string;
  familyId: string;
  personId: string;
  platform: string;
  revoked: boolean;
  deviceSecretHash: string;
}

export interface MaaPersonRecord {
  id: string;
  familyId: string;
  displayName: string;
  role: 'parent' | 'child' | 'circle' | 'vendor';
}

export interface MaaVoicePostRecord {
  id: string;
  familyId: string;
  senderId: string;
  recipientId: string;
  replyTo: string | null;
  state: MaaVoiceState;
  consentId: string;
  createdAt: string;
  durationS?: number | null;
  playedAt?: string | null;
}

export interface MaaUrgentIncidentRecord {
  id: string;
  familyId: string;
  subjectPersonId: string;
  state: MaaUrgentState;
  severity: 'routine' | 'urgent' | 'critical';
  responderId: string | null;
  promisedAt: string | null;
  createdAt: string;
}

export interface MaaIncidentAssignmentRecord {
  id: string;
  incidentId: string;
  familyId: string;
  assigneePersonId: string;
  state: MaaAssignmentState;
  offeredAt: string;
  respondedAt: string | null;
  promisedAt: string | null;
  expiresAt?: string | null;
}

export interface MaaCommandIdempotencyRecord {
  id: string;
  payloadHash: string;
  entityId?: string | null;
}

export interface MaaRepo {
  getDevice(deviceId: string): Promise<MaaDeviceRecord | null>;
  touchDeviceHeartbeat?(deviceId: string, lastSeenAt: string): Promise<void>;
  getPersonInFamily(familyId: string, personId: string): Promise<MaaPersonRecord | null>;
  listPeopleInFamily(familyId: string): Promise<MaaPersonRecord[]>;

  listVoicePostsForRecipient(
    familyId: string,
    recipientId: string,
    limit: number,
  ): Promise<MaaVoicePostRecord[]>;
  getVoicePostById(postId: string): Promise<MaaVoicePostRecord | null>;
  markVoicePostHeard(
    familyId: string,
    postId: string,
    recipientId: string,
    heardAt: string,
  ): Promise<{ playedAt: string }>;
  getVoiceContent(familyId: string, postId: string): Promise<VoiceContentRow | null>;

  getConsent(familyId: string, consentId: string): Promise<ConsentRow | null>;
  listConsentHistory(familyId: string, personId: string, purpose: string): Promise<ConsentRow[]>;
  createVoiceShareConsent(
    familyId: string,
    personId: string,
    recipientId: string,
    version: string,
    nowIso: string,
  ): Promise<ConsentRow>;

  uploadVoiceObject(objectPath: string, bytes: Uint8Array, contentType: string): Promise<void>;
  createFamilyVoicePost(params: {
    familyId: string;
    senderId: string;
    recipientId: string;
    objectPath: string;
    consentId: string;
    replyTo: string | null;
  }): Promise<MaaVoicePostRecord>;

  findCommandIdempotency(scopedIdempotencyKey: string): Promise<MaaCommandIdempotencyRecord | null>;
  persistCommandEvent(params: {
    eventId: string;
    familyId: string;
    scopedIdempotencyKey: string;
    payloadHash: string;
    payloadCiphertext: string;
    commandType: 'voice_message' | 'urgent_help';
    actorPersonId: string;
    entityId?: string | null;
  }): Promise<void>;

  createUrgentIncidentOffer(params: {
    familyId: string;
    subjectPersonId: string;
    severity: 'routine' | 'urgent' | 'critical';
    offerTimeoutMinutes?: number;
  }): Promise<{
    incidentId: string;
    assignmentId?: string;
    state: MaaUrgentState;
  }>;
  getUrgentIncidentById(incidentId: string): Promise<MaaUrgentIncidentRecord | null>;
  listIncidentAssignments(familyId: string, incidentId: string): Promise<MaaIncidentAssignmentRecord[]>;

  authorizeMedia(ctx: MediaAuthorizationContext): Promise<'allow' | 'deny'>;
  storage: StorageSigner;
}
