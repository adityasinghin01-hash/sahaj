#!/usr/bin/env node
/**
 * Apply Sahaj Shield SQL files to DATABASE_URL in deterministic order.
 *
 * Order matches scripts/lab/_common.sh:
 *   1. infra/supabase/dev/core_stub.sql — ONLY if public.families does not exist yet
 *      and dev/core_stub.sql has not already been tracked.
 *   2. infra/supabase/migrations/*.sql — sorted lexicographically by filename (C/ASCII order).
 *   3. infra/supabase/dev/seed_demo.sql — ONLY when `--seed` is passed.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node apps/shield-api/scripts/migrate.mjs [--seed] [--root <dir>]
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "../../..");

function parseArgs(argv) {
  let seed = false;
  let root = process.env.MIGRATE_ROOT ? resolve(process.env.MIGRATE_ROOT) : DEFAULT_ROOT;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seed") {
      seed = true;
    } else if (arg === "--root") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--root requires a directory path");
      }
      root = resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node apps/shield-api/scripts/migrate.mjs [--seed] [--root <dir>]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { seed, root };
}

function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatPgError(err) {
  if (!err || typeof err !== "object") return "unknown database error";
  const parts = [];
  if (typeof err.code === "string" && err.code) parts.push(`code=${err.code}`);
  if (typeof err.message === "string" && err.message) {
    // Strip any accidental URL/credential substrings just in case.
    const sanitized = err.message.replace(/\bpostgres(?:ql)?:\/\/\S+/gi, "<DATABASE_URL>");
    parts.push(sanitized);
  }
  return parts.join(" ") || "database error";
}

async function ensureMigrationsTable(sql) {
  await sql.unsafe(`
    create table if not exists public.schema_migrations (
      file text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    );
  `);
}

async function applyTrackedFile(sql, key, filePath) {
  const content = readFileSync(filePath, "utf8");
  const sha = sha256Hex(content);

  const existing = await sql`
    select sha256
    from public.schema_migrations
    where file = ${key}
    limit 1
  `;

  if (existing.length > 0) {
    if (existing[0].sha256 !== sha) {
      throw new Error(
        `checksum mismatch for already-applied migration "${key}" (expected ${existing[0].sha256}, got ${sha})`,
      );
    }
    process.stdout.write(`skip ${key} (already applied)\n`);
    return false;
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(content);
    await tx`
      insert into public.schema_migrations (file, sha256)
      values (${key}, ${sha})
    `;
  });

  process.stdout.write(`apply ${key} (${sha.slice(0, 12)})\n`);
  return true;
}

async function main() {
  const { seed, root } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    process.stderr.write("ERROR: DATABASE_URL is not set\n");
    process.exitCode = 1;
    return;
  }

  const supabaseDir = join(root, "infra", "supabase");
  const coreStubPath = join(supabaseDir, "dev", "core_stub.sql");
  const migrationsDir = join(supabaseDir, "migrations");
  const seedPath = join(supabaseDir, "dev", "seed_demo.sql");

  if (!existsSync(migrationsDir)) {
    process.stderr.write(`ERROR: migrations directory not found: ${migrationsDir}\n`);
    process.exitCode = 1;
    return;
  }

  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 15,
    onnotice: () => undefined,
  });

  let applied = 0;
  let skipped = 0;

  try {
    await ensureMigrationsTable(sql);

    if (existsSync(coreStubPath)) {
      const stubKey = "dev/core_stub.sql";
      const trackedStub = await sql`
        select sha256
        from public.schema_migrations
        where file = ${stubKey}
        limit 1
      `;

      if (trackedStub.length > 0) {
        const wasApplied = await applyTrackedFile(sql, stubKey, coreStubPath);
        if (wasApplied) applied += 1;
        else skipped += 1;
      } else {
        const [{ reg }] = await sql`
          select to_regclass('public.families')::text as reg
        `;
        if (reg === null) {
          const wasApplied = await applyTrackedFile(sql, stubKey, coreStubPath);
          if (wasApplied) applied += 1;
          else skipped += 1;
        } else {
          process.stdout.write(
            `skip ${stubKey} (public.families already exists)\n`,
          );
          skipped += 1;
        }
      }
    }

    const migrationFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort(asciiCompare);

    for (const filename of migrationFiles) {
      const wasApplied = await applyTrackedFile(
        sql,
        `migrations/${filename}`,
        join(migrationsDir, filename),
      );
      if (wasApplied) applied += 1;
      else skipped += 1;
    }

    if (seed) {
      if (!existsSync(seedPath)) {
        throw new Error(`seed file not found: ${seedPath}`);
      }
      const wasApplied = await applyTrackedFile(sql, "dev/seed_demo.sql", seedPath);
      if (wasApplied) applied += 1;
      else skipped += 1;
    }

    const [{ total }] = await sql`
      select count(*)::int as total from public.schema_migrations
    `;
    process.stdout.write(
      `migrate complete: applied=${applied} skipped=${skipped} total_tracked=${total}\n`,
    );
  } catch (err) {
    process.stderr.write(`ERROR: ${formatPgError(err)}\n`);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

await main();

