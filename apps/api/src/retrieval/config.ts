import type { RetrievalConfig } from "@forma/shared";

/**
 * Default retrieval configuration.
 *
 * Values are selected by the eval harness (`python scripts/evaluate.py`) on the
 * licensing-golden dataset — see evals/results/ for the runs that justify them.
 * Until the first sweep lands these are literature-standard starting points
 * (RRF k=60 from Cormack et al.; retrieve-50/rerank-to-5 per project convention)
 * and are all overridable per-request for experiments via SearchRequest.config.
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
