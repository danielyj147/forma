import type { SearchFilters } from "@forma/shared";
import type { Env } from "../env";
import { useMockAi, mockEmbed } from "./embeddings";

export interface VectorHit {
  id: string;
  score: number;
}

export interface VectorItem {
  id: string;
  values: number[];
  metadata: Record<string, string | number>;
}

/**
 * Thin store abstraction: Vectorize in deployed envs; a D1-backed brute-force
 * cosine store when DEV_MOCK_AI=1 (Vectorize has no local simulator).
 */
export async function vectorQuery(
  env: Env,
  vector: number[],
  topK: number,
  filters?: SearchFilters,
): Promise<VectorHit[]> {
  if (useMockAi(env)) return devQuery(env, vector, topK, filters);

  const filter: Record<string, string> = {};
  if (filters?.documentId) filter.document_id = filters.documentId;
  if (filters?.state) filter.state = filters.state;
  if (filters?.licenseType) filter.license_type = filters.licenseType;

  const res = await env.VECTORS.query(vector, {
    topK,
    returnValues: false,
    returnMetadata: "none",
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  });
  return res.matches.map((m) => ({ id: m.id, score: m.score }));
}

export async function vectorUpsert(env: Env, items: VectorItem[]): Promise<void> {
  if (items.length === 0) return;
  if (useMockAi(env)) {
    const stmts = items.map((it) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO dev_vectors (chunk_id, document_id, vector) VALUES (?1, ?2, ?3)",
      ).bind(it.id, String(it.metadata.document_id ?? ""), JSON.stringify(it.values)),
    );
    await env.DB.batch(stmts);
    return;
  }
  for (let i = 0; i < items.length; i += 500) {
    await env.VECTORS.upsert(items.slice(i, i + 500));
  }
}

export async function vectorDelete(env: Env, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (useMockAi(env)) {
    const stmts = ids.map((id) => env.DB.prepare("DELETE FROM dev_vectors WHERE chunk_id = ?1").bind(id));
    await env.DB.batch(stmts);
    return;
  }
  for (let i = 0; i < ids.length; i += 500) {
    await env.VECTORS.deleteByIds(ids.slice(i, i + 500));
  }
}

// ---------------------------------------------------------------------------
// Dev store (brute force over dev_vectors, joined to chunks for filters)
// ---------------------------------------------------------------------------

async function devQuery(
  env: Env,
  vector: number[],
  topK: number,
  filters?: SearchFilters,
): Promise<VectorHit[]> {
  const where: string[] = [];
  const binds: string[] = [];
  if (filters?.documentId) {
    where.push(`c.document_id = ?${binds.length + 1}`);
    binds.push(filters.documentId);
  }
  if (filters?.state) {
    where.push(`c.state = ?${binds.length + 1}`);
    binds.push(filters.state);
  }
  if (filters?.licenseType) {
    where.push(`c.license_type = ?${binds.length + 1}`);
    binds.push(filters.licenseType);
  }
  const sql = `SELECT v.chunk_id AS id, v.vector AS vec FROM dev_vectors v
     JOIN chunks c ON c.id = v.chunk_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{ id: string; vec: string }>();

  const hits: VectorHit[] = [];
  for (const row of rows.results) {
    const stored = JSON.parse(row.vec) as number[];
    hits.push({ id: row.id, score: cosine(vector, stored) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Exported for the ingest path so mock embeddings stay in one place. */
export { mockEmbed };
