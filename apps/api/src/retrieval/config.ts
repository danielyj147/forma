import type { RetrievalConfig } from "@forma/shared";

/**
 * Default retrieval configuration — selected by the licensing-golden sweep
 * (evals/results/20260709-103655-stage1.json, 20260709-104240-stage2.json,
 * n=41):
 *
 *   mode        MRR    Recall@5  NDCG@5
 *   bm25-only   0.482  0.707     0.539
 *   dense-only  0.482  0.658     0.526
 *   hybrid      0.618  0.878     0.683   ← fusion beats both legs
 *   hybrid+rr   0.753  0.878     0.785   ← rerank +0.135 MRR, +0.102 NDCG
 *
 * rrfK ∈ {20,60,120} and decayLambda ∈ {0,0.1,0.3} are metric-neutral under
 * reranking on this corpus (identical scores) — rrfK stays at the literature
 * standard 60; decayLambda=0.1 keeps the required freshness preference at
 * zero measured retrieval cost. Re-sweep decay when the corpus gains
 * same-topic documents of different ages. All values overridable per-request
 * via SearchRequest.config.
 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  denseTopK: 50,
  bm25TopK: 50,
  rrfK: 60,
  decayLambda: 0.1,
  decayFloor: 0.5,
  rerank: true,
  rerankTopK: 50,
  finalK: 5,
};

export function mergeConfig(override?: Partial<RetrievalConfig>): RetrievalConfig {
  return { ...DEFAULT_RETRIEVAL_CONFIG, ...(override ?? {}) };
}
