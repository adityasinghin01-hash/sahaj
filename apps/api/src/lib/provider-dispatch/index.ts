export * from "./types";
export * from "./dispatch";
export * from "./normalize";
export * from "./jobs";
export {
  createContactResolver, registerContactIdentity, revokeContactIdentity, contactAad, contactDigits, ContactError,
  type ContactDb, type ContactProvider, type ContactResolver, type ResolvedContact, type ContactSource, type ContactResolverConfig, type ContactCrypto, type RegisterContactInput, type RegisterResult,
} from "./contacts";
export { dispatchStore, type RpcClient } from "./supabase-store";
export async function acceptResponderFromVerifiedEvent(
  store: import("./types").DispatchStore, familyId: string, assignmentId: string, providerEventId: string,
): Promise<boolean> {
  // Only a persisted provider event id is accepted. There is deliberately no "success" flag parameter: the SQL function
  // re-derives acceptance from the event type, assignment, person and a call this system placed to that person.
  return store.acceptAssignment(familyId, assignmentId, providerEventId);
}
