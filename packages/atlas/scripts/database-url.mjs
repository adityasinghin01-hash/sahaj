import { fileURLToPath } from 'node:url';

/** Keep CA and hostname verification enabled for the hosted checkpoint connection. */
export function verifiedDatabaseUrl(connectionString) {
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    throw new Error('Invalid checkpoint PostgreSQL connection configuration');
  }
  const mode = parsed.searchParams.get('sslmode');
  if (mode && mode !== 'verify-full') throw new Error('Checkpoint connection requires verify-full TLS');
  parsed.searchParams.set('sslmode', 'verify-full');
  if (parsed.hostname.endsWith('.supabase.com') || parsed.hostname.endsWith('.supabase.co')) {
    parsed.searchParams.set('sslrootcert', fileURLToPath(new URL('../certs/supabase-root-2021.crt', import.meta.url)));
  }
  return parsed.toString();
}
