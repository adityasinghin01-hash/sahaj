import postgres, { type Sql } from "postgres";

export interface DbPools {
  /** Dedicated to createShieldRuntime(ports.sql); brain holds a session advisory lock on a reserved connection. */
  shieldSql: Sql;
  /** Separate pool for sign, outbox, scheduler, cache, cron, and health checks to avoid pool exhaustion deadlocks. */
  auxSql: Sql;
}

const GLOBAL_KEY = "__sahajShieldApiPools__" as const;

type GlobalWithPools = typeof globalThis & {
  [GLOBAL_KEY]?: { url: string; pools: DbPools };
};

function makePool(url: string, max: number): Sql {
  return postgres(url, {
    prepare: false,
    max_pipeline: 1,
    max,
    query_timeout: 10,
    onnotice: () => undefined,
  });
}

export function getDbPools(databaseUrl: string): DbPools {
  const g = globalThis as GlobalWithPools;
  if (g[GLOBAL_KEY] && g[GLOBAL_KEY].url === databaseUrl) {
    return g[GLOBAL_KEY].pools;
  }
  const pools: DbPools = {
    shieldSql: makePool(databaseUrl, 10),
    auxSql: makePool(databaseUrl, 10),
  };
  g[GLOBAL_KEY] = { url: databaseUrl, pools };
  return pools;
}

