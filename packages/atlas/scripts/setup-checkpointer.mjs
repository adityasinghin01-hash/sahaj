import pg from 'pg';
import { verifiedDatabaseUrl } from './database-url.mjs';

// Explicit operator command only. Never import from a request handler.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for checkpoint setup');
const connectionString = verifiedDatabaseUrl(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString, max: 1 });
let client;
let stage = 'connect';
const safeCodes = new Set(['42501', '28P01', '28000', '3D000', '3F000', '42P01', '42704', '42P07', '53300', '53400', '57P03', '08001', '08006', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
try {
  client = await pool.connect();
  stage = 'lock';
  await client.query("select pg_advisory_lock(hashtext('sahaj:checkpoint-setup:v1'))");
  stage = 'schema';
  // Administrative migrations provision the pinned SDK schema. Runtime needs no
  // database CREATE privilege (even CREATE SCHEMA IF NOT EXISTS requires it).
  const version = await client.query('select max(v) as version, count(*) as count from sahaj_checkpoints.checkpoint_migrations');
  if (version.rows[0]?.version !== 5 || Number(version.rows[0]?.count) !== 6) throw new Error('Apply checkpoint schema migration first');
  stage = 'harden-schema';
  // Revoke access before migrations, so interruption cannot expose new tables.
  await client.query('revoke all on schema sahaj_checkpoints from public');
  await client.query(`do $hardening$
  declare role_name text;
  begin
    foreach role_name in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on schema sahaj_checkpoints from %I', role_name);
        execute format('alter default privileges in schema sahaj_checkpoints revoke all on tables from %I', role_name);
      end if;
    end loop;
  end $hardening$`);
  stage = 'setup';
  // Never call saver.setup() here: its CREATE SCHEMA would require database-wide
  // CREATE. SDK upgrades must have an explicitly reviewed administrative migration.
  stage = 'harden-tables';
  await client.query(`do $hardening$
  declare table_name text; role_name text;
  begin
    for table_name in select tablename from pg_tables where schemaname = 'sahaj_checkpoints' loop
      execute format('alter table sahaj_checkpoints.%I enable row level security', table_name);
      execute format('revoke all on table sahaj_checkpoints.%I from public', table_name);
      foreach role_name in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = role_name) then
          execute format('revoke all on table sahaj_checkpoints.%I from %I', table_name, role_name);
        end if;
      end loop;
    end loop;
  end $hardening$`);
  console.log('Private Atlas checkpoint migration verified and schema hardened.');
} catch (error) {
  // Driver errors can contain credentials/connection details; never echo them.
  const code = safeCodes.has(error?.code) ? error.code : 'UNCLASSIFIED';
  console.error(`Checkpoint initialization failed: stage=${stage} code=${code}.`);
  process.exitCode = 1;
} finally {
  if (client) {
    await client.query("select pg_advisory_unlock(hashtext('sahaj:checkpoint-setup:v1'))").catch(() => {});
    client.release();
  }
  await pool.end();
}
