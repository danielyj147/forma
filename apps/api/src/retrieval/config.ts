import type { RetrievalConfig } from "@forma/shared";

/**
 * Default retrieval configuration — selected by the licensing-golden sweep
 * (latest: evals/results/20260709-141507-stage1-7docs.json, n=65, 7-doc
 * corpus with contextual table summaries):
 *
 *   mode        MRR    Recall@5  NDCG@5
 *   bm25-only   0.500  0.631     0.533
 *   dense-only  0.641  0.831     0.688
 *   hybrid      0.731  0.877     0.768   ← fusion beats both legs
 *   hybrid+rr   0.891  0.954     0.907   ← rerank remains the largest lever
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
