import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppHarnessResponse } from "@sahaj/shared";
import { idempotentAppPair } from "./app_pair";
import { getShieldApp } from "./app";
import { getDbPools } from "./db";
import { createAppStore } from "./app_store";
import type { AppDependencies } from "./app_handlers";

export async function readAppHarness() {
  const root = process.cwd().endsWith("shield-api")
    ? resolve(process.cwd(), "../..")
    : process.cwd();
  try {
    const raw = JSON.parse(
      await readFile(resolve(root, "harness/shield/results.json"), "utf8"),
    );
    const summary = Object.fromEntries(
      Object.entries(raw.summary ?? {}).filter(
        ([, v]) => typeof v === "number" && Number.isFinite(v),
      ),
    );
    return AppHarnessResponse.parse({
      available: true,
      mode: typeof raw.mode === "string" ? raw.mode : null,
      summary,
      ai: raw.ai_eval ?? raw.ai ?? null,
    });
  } catch {
    return AppHarnessResponse.parse({
      available: false,
      mode: null,
      summary: {},
      ai: null,
    });
  }
}
export function getAppDependencies(): AppDependencies {
  const app = getShieldApp();
  const sql = getDbPools(app.env.DATABASE_URL!).auxSql;
  return {
    app,
    store: createAppStore(sql),
    harness: readAppHarness,
    pair: (member, key, create) =>
      idempotentAppPair(sql, app.env.SUPABASE_JWT_SECRET!, member, key, create),
  };
}
