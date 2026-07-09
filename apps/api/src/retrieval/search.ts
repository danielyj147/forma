import type {
  RetrievalConfig,
  SearchDebug,
  SearchFilters,
  SearchResult,
  ChunkKind,
  SourceRect,
} from "@forma/shared";
import type { Env } from "../env";
import { mergeConfig } from "./config";
import { embedTexts, rerankByQuery } from "./embeddings";
import { vectorQuery } from "./vectorstore";
import { applyTimeDecay, rrfFuse, toFtsQuery, toRanks } from "./fusion";

interface ChunkRow {
  id: string;
  document_id: string;
  parent_id: string | null;
  kind: ChunkKind;
  content: string;
  page_number: number | null;
  coordinates: string | null;
  filing_date: string | null;
  doc_title: string;
}

export interface RetrieveOutput {
  results: SearchResult[];
  debug?: SearchDebug;
}

/**
 * The retrieval pipeline (ADR-2, ADR-3):
 *   dense top-K (Vectorize) ∥ BM25 top-K (D1 FTS5)
 *   → RRF fusion → linear time-decay on filing_date
 *   → cross-encoder rerank of top candidates → final top-K
 *   → parent-child expansion (table summaries swap in full table markdown)
 */
export async function retrieve(
  env: Env,
  query: string,
  filters?: SearchFilters,
  configOverride?: Partial<RetrievalConfig>,
  debug = false,
): Promise<RetrieveOutput> {
  const cfg = mergeConfig(configOverride);
  const timings: Record<string, number> = {};
  const t0 = Date.now();

  // --- candidate generation (both legs run concurrently) -------------------
  const wantDense = cfg.mode !== "bm25";
  const wantBm25 = cfg.mode !== "dense";

  const [denseIds, bm25Ids] = await Promise.all([
    wantDense ? denseLeg(env, query, cfg.denseTopK, filters) : Promise.resolve([]),
    wantBm25 ? bm25Leg(env, query, cfg.bm25TopK, filters) : Promise.resolve([]),
  ]);
  timings.candidates = Date.now() - t0;

  const denseRanks = toRanks(denseIds);
  const bm25Ranks = toRanks(bm25Ids);

  // --- fusion ---------------------------------------------------------------
  const rankings = [denseRanks, bm25Ranks].filter((m) => m.size > 0);
  const fused = rrfFuse(rankings, cfg.rrfK);
  if (fused.size === 0) {
    return { results: [], debug: debug ? emptyDebug(cfg, denseRanks, bm25Ranks, timings) : undefined };
  }

  // --- hydrate candidate rows (needed for decay dates + rerank text) --------
  const tHydrate = Date.now();
  const rows = await fetchChunkRows(env, [...fused.keys()]);
  timings.hydrate = Date.now() - tHydrate;

  const filingDates = new Map<string, string | null>();
  for (const r of rows.values()) filingDates.set(r.id, r.filing_date);

  // --- freshness ------------------------------------------------------------
  const decayed = applyTimeDecay(fused, filingDates, cfg.decayLambda, cfg.decayFloor, new Date());
  const ordered = [...decayed.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  // --- rerank ----------------------------------------------------------------
  let rerankScores: Map<string, number> | null = null;
  let finalIds: string[];
  if (cfg.rerank) {
    const tRerank = Date.now();
    const candidates = ordered
      .slice(0, cfg.rerankTopK)
      .map((id) => rows.get(id))
      .filter((r): r is ChunkRow => !!r)
      .map((r) => ({ id: r.id, text: r.content }));
    rerankScores = await rerankByQuery(env, query, candidates);
    timings.rerank = Date.now() - tRerank;
    finalIds = [...rerankScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, cfg.finalK)
      .map(([id]) => id);
  } else {
    finalIds = ordered.slice(0, cfg.finalK);
  }

  // --- parent-child expansion + dedup ---------------------------------------
  const results = await expandParents(env, finalIds, rows, (id) =>
    rerankScores?.get(id) ?? decayed.get(id) ?? 0,
  );
  timings.total = Date.now() - t0;

  return {
    results,
    debug: debug
      ? {
          denseRanks: Object.fromEntries(denseRanks),
          bm25Ranks: Object.fromEntries(bm25Ranks),
          fusedScores: Object.fromEntries(fused),
          decayedScores: Object.fromEntries(decayed),
          rerankScores: rerankScores ? Object.fromEntries(rerankScores) : null,
          config: cfg,
          timingsMs: timings,
        }
      : undefined,
  };
}

async function denseLeg(
  env: Env,
  query: string,
  topK: number,
  filters?: SearchFilters,
): Promise<string[]> {
  const [vector] = await embedTexts(env, [query]);
  const hits = await vectorQuery(env, vector, topK, filters);
  return hits.map((h) => h.id);
}

async function bm25Leg(
  env: Env,
  query: string,
  topK: number,
  filters?: SearchFilters,
): Promise<string[]> {
  const match = toFtsQuery(query);
  if (!match) return [];

  const where: string[] = ["chunks_fts MATCH ?1"];
  const binds: (string | number)[] = [match];
  if (filters?.documentId) {
    binds.push(filters.documentId);
    where.push(`c.document_id = ?${binds.length}`);
  }
  if (filters?.state) {
    binds.push(filters.state);
    where.push(`c.state = ?${binds.length}`);
  }
  if (filters?.licenseType) {
    binds.push(filters.licenseType);
    where.push(`c.license_type = ?${binds.length}`);
  }
  binds.push(topK);

  // bm25() returns lower-is-better; ORDER BY ascending = best first.
  const sql = `SELECT c.id AS id FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY bm25(chunks_fts) LIMIT ?${binds.length}`;
  const res = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{ id: string }>();
  return res.results.map((r) => r.id);
}

async function fetchChunkRows(env: Env, ids: string[]): Promise<Map<string, ChunkRow>> {
  const map = new Map<string, ChunkRow>();
  for (let i = 0; i < ids.length; i += 80) {
    const batch = ids.slice(i, i + 80);
    const placeholders = batch.map((_, j) => `?${j + 1}`).join(",");
    const res = await env.DB.prepare(
      `SELECT c.id, c.document_id, c.parent_id, c.kind, c.content, c.page_number,
              c.coordinates, c.filing_date, d.title AS doc_title
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.id IN (${placeholders})`,
    )
      .bind(...batch)
      .all<ChunkRow>();
    for (const row of res.results) map.set(row.id, row);
  }
  return map;
}

/**
 * Parent-child pattern: table summaries are what got embedded, but the LLM
 * should see the full Docling table markdown (the parent). Dedupes when both
 * the summary and the parent table surface independently.
 */
async function expandParents(
  env: Env,
  finalIds: string[],
  rows: Map<string, ChunkRow>,
  scoreOf: (id: string) => number,
): Promise<SearchResult[]> {
  const parentIdsToFetch = new Set<string>();
  for (const id of finalIds) {
    const row = rows.get(id);
    if (row?.kind === "table_summary" && row.parent_id && !rows.has(row.parent_id)) {
      parentIdsToFetch.add(row.parent_id);
    }
  }
  if (parentIdsToFetch.size > 0) {
    const fetched = await fetchChunkRows(env, [...parentIdsToFetch]);
    for (const [id, row] of fetched) rows.set(id, row);
  }

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const id of finalIds) {
    const row = rows.get(id);
    if (!row) continue;

    let effective = row;
    if (row.kind === "table_summary" && row.parent_id) {
      effective = rows.get(row.parent_id) ?? row;
    }
    if (seen.has(effective.id)) continue;
    seen.add(effective.id);

    results.push({
      chunkId: effective.id,
      documentId: effective.document_id,
      documentTitle: effective.doc_title,
      kind: effective.kind,
      content: effective.content,
      page: effective.page_number,
      rects: parseRects(effective.coordinates),
      score: scoreOf(id),
    });
  }
  return results;
}

function parseRects(coordinates: string | null): SourceRect[] {
  if (!coordinates) return [];
  try {
    const parsed = JSON.parse(coordinates) as SourceRect[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function emptyDebug(
  cfg: RetrievalConfig,
  denseRanks: Map<string, number>,
  bm25Ranks: Map<string, number>,
  timings: Record<string, number>,
): SearchDebug {
  return {
    denseRanks: Object.fromEntries(denseRanks),
    bm25Ranks: Object.fromEntries(bm25Ranks),
    fusedScores: {},
    decayedScores: {},
    rerankScores: null,
    config: cfg,
    timingsMs: timings,
  };
}
