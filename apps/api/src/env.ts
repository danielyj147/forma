export interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  AI: Ai;
  PDFS: R2Bucket;
  RL: KVNamespace;
  ASSETS: Fetcher;

  ENVIRONMENT: string;

  // Secrets (wrangler secret put / .dev.vars)
  ANTHROPIC_API_KEY: string;
  INGEST_TOKEN: string;
  /** When set, /api/chat and /api/search require the x-access-code header. */
  ACCESS_CODE?: string;
  /** "1" swaps Workers AI + Vectorize for deterministic local mocks (offline dev). */
  DEV_MOCK_AI?: string;
}
