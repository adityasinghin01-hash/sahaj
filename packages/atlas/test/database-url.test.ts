import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { verifiedDatabaseUrl } from '../scripts/database-url.mjs';

describe('checkpoint TLS configuration', () => {
  it('uses the bundled official CA and hostname verification for Supabase', () => {
    const url = new URL(verifiedDatabaseUrl('postgresql://synthetic:synthetic@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres'));
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(existsSync(url.searchParams.get('sslrootcert')!)).toBe(true);
  });
  it.each(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'no-verify'])('rejects weaker TLS mode %s', (mode) => {
    expect(() => verifiedDatabaseUrl(`postgresql://synthetic@db.example/postgres?sslmode=${mode}`)).toThrow();
  });
  it('does not attach the Supabase certificate to other hosts', () => {
    expect(new URL(verifiedDatabaseUrl('postgresql://synthetic@supabase.com.example/postgres')).searchParams.has('sslrootcert')).toBe(false);
  });
});
