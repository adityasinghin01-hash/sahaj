import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Minimal supabase-js stand-in over ONE real psql session, for scratch-database tests only. `rpc` and `from()` are translated to
 * SQL and wrapped in pg_temp.sahaj_rpc, which catches errors in a subtransaction and returns {ok,data}|{ok:false,code,message}, the
 * same shape PostgREST gives supabase-js. Everything runs inside one transaction that the test rolls back.
 * Connection is fixed to the loopback scratch database; nothing is read from the environment except the psql path.
 */
type Val = string | number | boolean | null | Record<string, unknown> | unknown[];
const lit = (v: Val): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

export class PsqlSession {
  private proc: ChildProcessWithoutNullStreams;
  private out = ""; private err = "";
  private waiters: Array<(s: string) => void> = [];
  private seq = 0;
  constructor(psqlPath: string) {
    this.proc = spawn(psqlPath, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=0", "-h", "127.0.0.1", "-p", "55439", "-U", "postgres", "-d", "postgres"], { stdio: "pipe" });
    this.proc.stdout.setEncoding("utf8"); this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => { this.out += d; this.drain(); });
    this.proc.stderr.on("data", (d: string) => { this.err += d; });
  }
  private drain() {
    for (;;) {
      const m = /__END_(\d+)__\r?\n/.exec(this.out);
      if (!m) return;
      const body = this.out.slice(0, m.index); this.out = this.out.slice(m.index + m[0].length);
      this.waiters.shift()?.(body.trim());
    }
  }
  /** Raw SQL (fixtures, assertions). Throws if psql reported an error. */
  async sql(text: string): Promise<string> {
    const n = ++this.seq; this.err = "";
    const p = new Promise<string>((res) => this.waiters.push(res));
    // A missing terminator would leave the query buffered past the marker, so every statement batch is terminated here.
    const body = /;\s*$/.test(text) ? text : `${text};`;
    this.proc.stdin.write(`${body}\n\\echo __END_${n}__\n`);
    const r = await p;
    if (/ERROR:/.test(this.err)) throw new Error(`psql: ${this.err.trim().split("\n").slice(0,3).join(" / ")} <- ${text.slice(0, 120)}`);
    return r;
  }
  async call(inner: string): Promise<{ data: unknown; error: { code: string; message: string } | null }> {
    const r = JSON.parse(await this.sql(`select pg_temp.sahaj_rpc(${lit(inner)});`)) as { ok: boolean; data?: unknown; code?: string; message?: string };
    return r.ok ? { data: r.data ?? null, error: null } : { data: null, error: { code: r.code!, message: r.message! } };
  }
  async begin() {
    await this.sql(`begin;
create function pg_temp.sahaj_rpc(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb; begin execute p_sql into r; return jsonb_build_object('ok',true,'data',r);
exception when others then return jsonb_build_object('ok',false,'code',sqlstate,'message',sqlerrm); end $$;`);
  }
  async end() { try { await this.sql("rollback;"); } finally { this.proc.stdin.end(); this.proc.kill(); } }

  /** supabase-js shaped client. */
  get db() {
    const session = this;
    return {
      rpc: (name: string, args: Record<string, unknown>) => {
        const named = Object.entries(args).map(([k, v]) => `${k}=>${lit(v as Val)}`).join(",");
        return session.call(`select to_jsonb(public.${name}(${named}))`);
      },
      from: (table: string) => {
        let cols = "*"; const where: string[] = []; let limit: number | null = null;
        const run = async (single: boolean) => {
          const q = `select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from (select ${cols} from public.${table}${where.length ? " where " + where.join(" and ") : ""}${limit ? ` limit ${limit}` : ""}) t`;
          const r = await session.call(q);
          if (r.error || !single) return r;
          const rows = r.data as unknown[];
          return rows.length > 1 ? { data: null, error: { code: "PGRST116", message: "multiple rows" } } : { data: rows[0] ?? null, error: null };
        };
        const q: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
          select: (c: string) => { cols = c; return q; },
          eq: (c: string, v: Val) => { where.push(`${c}=${lit(v)}`); return q; },
          is: (c: string, v: null) => { where.push(`${c} is ${v === null ? "null" : lit(v)}`); return q; },
          limit: (n: number) => { limit = n; return q; },
          order: () => q,
          maybeSingle: () => run(true),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run(false).then(res, rej),
        };
        return q;
      },
    };
  }
}
