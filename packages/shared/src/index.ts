/**
 * Shared contracts between the Worker API, the web app, and (mirrored in
 * Python) the ingestion pipeline. Keep this file dependency-free.
 */

// ---------------------------------------------------------------------------
// Source provenance (Docling → UI highlighting)
// ---------------------------------------------------------------------------

/**
 * A rectangle on a PDF page, normalized to [0,1] with a TOP-LEFT origin.
 * Ingestion converts Docling's bottom-left-origin point coordinates using the
 * page dimensions, so the frontend can overlay it on any rendered size.
 */
export interface SourceRect {
  page: number; // 1-based
  rect: [left: number, top: number, right: number, bottom: number];
}

export type ChunkKind = "text" | "table" | "table_summary";

// ---------------------------------------------------------------------------
// Documents & form schemas
// ---------------------------------------------------------------------------

export interface DocumentSummary {
  id: string;
  title: string;
  state: string | null;
  licenseType: string | null;
  sourceUrl: string | null;
  filingDate: string | null; // ISO yyyy-mm-dd
  pageCount: number | null;
  /** URL path to fetch the PDF from this API, e.g. /api/pdf/<id> */
  pdfUrl: string;
  hasFormSchema: boolean;
}

export type FormFieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "checkbox"
  | "radio"
  | "file";

export interface FormFieldOption {
  value: string;
  label: string;
}

export interface FormField {
  id: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: FormFieldOption[]; // select | radio | checkbox groups
  /** Where this field appears in the source PDF (for highlight-on-focus). */
  source?: SourceRect[];
}

export interface FormSection {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
}

export interface FormSchema {
  documentId: string;
  title: string;
  sections: FormSection[];
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export type RetrievalMode = "hybrid" | "dense" | "bm25";

export interface RetrievalConfig {
  mode: RetrievalMode;
  /** Candidates fetched per leg before fusion. */
  denseTopK: number;
  bm25TopK: number;
  /** RRF constant k in 1/(k + rank). */
  rrfK: number;
  /** Linear time-decay per year of document age; 0 disables. */
  decayLambda: number;
  /** Score floor so old-but-relevant docs are damped, not erased. */
  decayFloor: number;
  rerank: boolean;
  /** How many fused candidates go to the cross-encoder. */
  rerankTopK: number;
  /** Results returned to the LLM / caller. */
  finalK: number;
}

export interface SearchFilters {
  documentId?: string;
  state?: string;
  licenseType?: string;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  kind: ChunkKind;
  /** Content given to the LLM (parent table markdown for table_summary hits). */
  content: string;
  page: number | null;
  rects: SourceRect[];
  score: number;
}

/** Per-stage diagnostics for evals (`debug: true` on /api/search). */
export interface SearchDebug {
  denseRanks: Record<string, number>;
  bm25Ranks: Record<string, number>;
  fusedScores: Record<string, number>;
  decayedScores: Record<string, number>;
  rerankScores: Record<string, number> | null;
  config: RetrievalConfig;
  timingsMs: Record<string, number>;
}

export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  config?: Partial<RetrievalConfig>;
  debug?: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  debug?: SearchDebug;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Late Context Injection: the ONLY channel by which user form data reaches the
 * server — ephemeral, per-request, never stored or embedded (ADR-5).
 */
export interface FormContextEntry {
  label: string;
  value: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  filters?: SearchFilters;
  formContext?: FormContextEntry[];
  /** Eval hook: override generation model selection. */
  forceModel?: "haiku" | "opus";
}

export interface Citation {
  n: number; // [n] marker in the answer text
  chunkId: string;
  documentId: string;
  documentTitle: string;
  page: number | null;
  rects: SourceRect[];
  snippet: string;
  /** Full retrieved content — used by the eval harness for faithfulness judging. */
  content?: string;
}

/** SSE events streamed by /api/chat. */
export type ChatEvent =
  | { type: "routing"; needsRetrieval: boolean; query?: string; model: string }
  | { type: "sources"; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "done"; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Admin ingestion API (Bearer INGEST_TOKEN)
// ---------------------------------------------------------------------------

export interface AdminDocumentUpsert {
  id: string;
  title: string;
  state?: string | null;
  licenseType?: string | null;
  sourceUrl?: string | null;
  filingDate?: string | null;
  pageCount?: number | null;
  formSchema?: FormSchema | null;
  doclingVersion?: string | null;
}

export interface AdminChunk {
  id: string;
  parentId?: string | null;
  kind: ChunkKind;
  content: string;
  /** Text embedded for retrieval; defaults to `content` (differs for tables). */
  embedText?: string;
  page?: number | null;
  rects?: SourceRect[];
}

export interface AdminChunksUpsert {
  documentId: string;
  chunks: AdminChunk[];
}
