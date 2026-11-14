import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { verifiedDatabaseUrl } from '../scripts/database-url.mjs';

export const CHECKPOINT_SCHEMA = 'sahaj_checkpoints';

/** No migrations here: run the explicit setup command once before workers start. */
export function createPostgresCheckpointer(connectionString: string): PostgresSaver {
  return PostgresSaver.fromConnString(verifiedDatabaseUrl(connectionString), { schema: CHECKPOINT_SCHEMA });
}
