import type { Env } from "../env";

/**
 * Embeddings + cross-encoder reranking via Workers AI (ADR-3). Index-time and
 * query-time both go through this module (ingestion embeds via the admin API),
 * so the model can never drift between the two.
 *
 * DEV_MOCK_AI=1 substitutes deterministic local implementations so `npm run
 * dev` works offline / without a Cloudflare account.
 */

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const RERANKER_MODEL = "@cf/baai/bge-reranker-base";
const AI_BATCH = 90;

export function useMockAi(env: Env): boolean {
  // Explicit opt-in, or the bindings simply aren't there (local dev config).
  return env.DEV_MOCK_AI === "1" || !env.AI || !env.VECTORS;
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (useMockAi(env)) return texts.map(mockEmbed);

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += AI_BATCH) {
    const batch = texts.slice(i, i + AI_BATCH);
    const res = (await env.AI!.run(EMBEDDING_MODEL as never, { text: batch } as never)) as unknown as {
      data: number[][];
    };
    if (!res?.data || res.data.length !== batch.length) {
      throw new Error(`embedding model returned ${res?.data?.length ?? 0} vectors for ${batch.length} inputs`);
    }
    out.push(...res.data);
  }
  return out;
}

/** Returns id -> relevance score (higher = more relevant). */
export async function rerankByQuery(
  env: Env,
  query: string,
  docs: Array<{ id: string; text: string }>,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (docs.length === 0) return scores;

  if (useMockAi(env)) {
    for (const d of docs) scores.set(d.id, mockOverlapScore(query, d.text));
    return scores;
  }

  // bge-reranker-base scores (query, passage) pairs; truncate passages to keep
  // within the model's 512-token window — the head of a chunk carries its topic.
  const contexts = docs.map((d) => ({ text: d.text.slice(0, 1600) }));
  const res = (await env.AI!.run(RERANKER_MODEL as never, { query, contexts } as never)) as unknown as {
    response: Array<{ id: number; score: number }>;
  };
  for (const item of res.response ?? []) {
    const doc = docs[item.id];
    if (doc) scores.set(doc.id, item.score);
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Deterministic mocks (offline dev only — never used in deployed envs)
// ---------------------------------------------------------------------------

export const MOCK_DIM = 256;

/** Character-trigram hashing into a normalized vector; stable across runs. */
export function mockEmbed(text: string): number[] {
  const v = new Array<number>(MOCK_DIM).fill(0);
  const s = text.toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < s.length - 2; i++) {
    let h = 2166136261;
    for (let j = i; j < i + 3; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % MOCK_DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function mockOverlapScore(query: string, text: string): number {
  const qs = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  const ts = new Set(text.toLowerCase().split(/\W+/).filter(Boolean));
  if (qs.size === 0) return 0;
  let hit = 0;
  for (const t of qs) if (ts.has(t)) hit++;
  return hit / qs.size;
}
