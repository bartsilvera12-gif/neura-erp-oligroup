/**
 * Etiquetas — FASE 3B: guard schema-aware.
 *
 * `schemaHasHiddenByTagColumn(pool, schema)` consulta information_schema.columns
 * para saber si el schema tenant tiene la columna `hidden_by_tag` en
 * `chat_conversations`. Cachea por schema (in-memory, reset al reinicio).
 *
 * Permite agregar el filtro `COALESCE(hidden_by_tag,false)=false` SOLO donde
 * la columna existe (Triple 7 en FASE 1 ya la tiene). Otros tenants sin la
 * columna no se ven afectados.
 */
import type { Pool } from "pg";

const cache = new Map<string, boolean>();

export async function schemaHasHiddenByTagColumn(pool: Pool, schema: string): Promise<boolean> {
  if (!schema || typeof schema !== "string") return false;
  const cached = cache.get(schema);
  if (cached !== undefined) return cached;
  try {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'chat_conversations'
          AND column_name = 'hidden_by_tag'`,
      [schema]
    );
    const has = (r.rows?.[0]?.n ?? 0) > 0;
    cache.set(schema, has);
    return has;
  } catch {
    return false;
  }
}

/** Para tests: limpia el cache. */
export function _resetSchemaHasHiddenColumnCache(): void {
  cache.clear();
}
