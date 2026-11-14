import type { Sql } from "postgres";
/** Seed real foundation identity constraints rather than permissive stub rows. */
export async function seedMembership(sql: Sql, familyId: string, userId: string, role: "child" | "parent" | "circle") {
  const personId = crypto.randomUUID();
  await sql`insert into auth.users(id) values (${userId}) on conflict(id) do nothing`;
  await sql`insert into public.people(id,family_id,display_name,role) values (${personId},${familyId},'Synthetic member',${role})`;
  await sql`insert into public.family_memberships(family_id,user_id,person_id,role) values (${familyId},${userId},${personId},${role})`;
}
