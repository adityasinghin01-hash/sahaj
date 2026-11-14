declare module 'pg' {
  export interface QueryResultRow {
    [column: string]: unknown;
  }
  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
  }
  export interface PoolClient {
    query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
  }
  export class Pool {
    constructor(config?: { connectionString?: string; max?: number });
    connect(): Promise<PoolClient>;
    query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
}
