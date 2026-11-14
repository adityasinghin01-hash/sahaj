/** Server-only routing. Never serialize a resolved contact into an app response. */
export type ContactSource = "whatsapp" | "sarvam";
export interface ShieldContacts {
  resolve(input: { familyId: string; personId: string; source: ContactSource }): Promise<string | null>;
  isFamilyNumber(input: { familyId: string; phoneHash: string }): Promise<boolean>;
  senderHash(source: ContactSource, digits: string): string | null;
}
