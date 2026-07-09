import type { DocumentSummary, FormSchema } from "@forma/shared";

const ACCESS_CODE_KEY = "forma:accessCode";

/** Error thrown for any non-2xx response or network failure (status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /** True when the error body was a structured JSON {error} from the API. */
  readonly hasJsonBody: boolean;

  constructor(message: string, status: number, code?: string, hasJsonBody = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hasJsonBody = hasJsonBody;
  }

  /**
   * Fetch failed outright, or the dev proxy answered 5xx with a non-JSON
   * body — both mean "the backend isn't reachable".
   */
  get isNetwork(): boolean {
    return this.status === 0 || (this.status >= 500 && !this.hasJsonBody);
  }

  get isAccessRequired(): boolean {
    return this.status === 401 && this.code === "access_code_required";
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }
}

// ---------------------------------------------------------------------------
// Access code (demo gate)
// ---------------------------------------------------------------------------

export function getAccessCode(): string | null {
  try {
    return localStorage.getItem(ACCESS_CODE_KEY);
  } catch {
    return null;
  }
}

export function setAccessCode(code: string): void {
  try {
    localStorage.setItem(ACCESS_CODE_KEY, code);
  } catch {
    // Storage unavailable — the code will only last for this page load.
  }
}

/** Headers for every /api request, including the access code when present. */
export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const code = getAccessCode();
  if (code) headers["x-access-code"] = code;
  return headers;
}

type AccessListener = () => void;
const accessListeners = new Set<AccessListener>();

/** Subscribe to "the API wants an access code" events (401 responses). */
export function onAccessRequired(listener: AccessListener): () => void {
  accessListeners.add(listener);
  return () => {
    accessListeners.delete(listener);
  };
}

function notifyAccessRequired(): void {
  for (const listener of accessListeners) listener();
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Convert a non-2xx Response into an ApiError (and signal the access gate). */
export async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  let code: string | undefined;
  let hasJsonBody = false;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    hasJsonBody = true;
    if (typeof body.error === "string" && body.error) message = body.error;
    if (typeof body.code === "string") code = body.code;
  } catch {
    // Non-JSON error body; keep the generic message.
  }
  const error = new ApiError(message, res.status, code, hasJsonBody);
  if (error.isAccessRequired) notifyAccessRequired();
  return error;
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: apiHeaders() });
  } catch {
    throw new ApiError("Could not reach the Forma API.", 0);
  }
  if (!res.ok) throw await toApiError(res);
  try {
    return (await res.json()) as T;
  } catch {
    // An HTML/garbage body on a 2xx means a static server answered instead
    // of the API (e.g. `vite preview` without the Worker running).
    throw new ApiError("Could not reach the Forma API.", 0);
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function fetchDocuments(): Promise<DocumentSummary[]> {
  const data = await getJson<{ documents: DocumentSummary[] }>("/api/documents");
  return data.documents;
}

export function fetchFormSchema(documentId: string): Promise<FormSchema> {
  return getJson<FormSchema>(`/api/documents/${encodeURIComponent(documentId)}/schema`);
}

/** pdf.js file descriptor for a document, carrying the access code header. */
export function pdfFileSource(doc: DocumentSummary): { url: string; httpHeaders?: Record<string, string> } {
  const code = getAccessCode();
  return code ? { url: doc.pdfUrl, httpHeaders: { "x-access-code": code } } : { url: doc.pdfUrl };
}
