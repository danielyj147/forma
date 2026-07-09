import type { Citation, FormContextEntry, SearchResult } from "@forma/shared";
import type { Env } from "../env";
import { anthropicClient, MODELS } from "./anthropic";

export interface CorpusDoc {
  id: string;
  title: string;
  state: string | null;
  license_type: string | null;
}

export interface GenerationInput {
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  results: SearchResult[];
  /** Full ingested-document list so the model describes coverage accurately. */
  corpus: CorpusDoc[];
  formContext?: FormContextEntry[];
  model: "haiku" | "opus";
}

export function buildCitations(results: SearchResult[]): Citation[] {
  return results.map((r, i) => ({
    n: i + 1,
    chunkId: r.chunkId,
    documentId: r.documentId,
    documentTitle: r.documentTitle,
    page: r.page,
    rects: r.rects,
    snippet: r.content.slice(0, 240),
    content: r.content,
  }));
}

const GROUNDING_RULES = `You are Forma, an assistant for regulatory licensing applications. You answer ONLY from the numbered context blocks provided.

Hard rules — no exceptions:
1. Every factual claim must cite its source with a bracketed number like [1] or [2][3], matching the context block it came from. Place citations immediately after the claim.
2. If the context does not contain the information needed, reply exactly: "I do not know based on the ingested documents." and then state what additional document or detail would let you answer. Never guess, extrapolate, or use outside knowledge about regulations — regulations change and stale knowledge is dangerous.
3. For numbers (fees, deadlines, thresholds, net-worth requirements), quote the exact figure from the context; re-check the table row and column before answering.
4. Be concise and direct. Use short paragraphs or bullet lists. No preamble.
5. When describing what documents or jurisdictions are AVAILABLE, use the <corpus> list — never infer coverage from which context blocks happened to be retrieved (retrieval returns a handful of chunks, not the corpus). If a question is too broad, ask a clarifying question and describe the options using the <corpus> list.`;

function corpusBlock(corpus: CorpusDoc[]): string {
  const lines = corpus
    .map(
      (d) =>
        `- "${d.title}" (jurisdiction: ${d.state ?? "multi-state"}, type: ${d.license_type ?? "general"})`,
    )
    .join("\n");
  return `<corpus note="the complete set of ingested documents">\n${lines}\n</corpus>`;
}

function buildSystem(results: SearchResult[], corpus: CorpusDoc[], formContext?: FormContextEntry[]): string {
  const blocks = results
    .map(
      (r, i) =>
        `<context n="${i + 1}" source="${r.documentTitle}${r.page ? `, page ${r.page}` : ""}">\n${r.content}\n</context>`,
    )
    .join("\n\n");

  let system = `${GROUNDING_RULES}\n\n${corpusBlock(corpus)}\n\n${blocks || "<context>NO CONTEXT RETRIEVED</context>"}`;

  if (formContext && formContext.length > 0) {
    // Late Context Injection (ADR-5): applicant data arrives per-request only,
    // is never embedded/stored, and must never be treated as policy.
    const fields = formContext.map((f) => `- ${f.label}: ${f.value}`).join("\n");
    system += `\n\n<applicant_state ephemeral="true">\nThe user shared these values from their in-progress application form (session-only, not stored). Evaluate them against the cited policy context when the question is about their own situation:\n${fields}\n</applicant_state>`;
  }
  return system;
}

/**
 * Grounded answer generation, streamed. Yields text deltas; the caller emits
 * SSE events. Model choice comes from the router (ADR-4 cost policy).
 */
export function streamAnswer(env: Env, input: GenerationInput) {
  const client = anthropicClient(env);
  const model = input.model === "opus" ? MODELS.complex : MODELS.simple;

  return client.messages.stream({
    model,
    max_tokens: 1200,
    system: buildSystem(input.results, input.corpus, input.formContext),
    messages: [
      ...input.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: input.question },
    ],
  });
}

/** No-retrieval path (greetings, meta questions). Still forbids invention. */
export function streamSmallTalk(env: Env, input: Omit<GenerationInput, "results">) {
  const client = anthropicClient(env);
  return client.messages.stream({
    model: MODELS.simple,
    max_tokens: 400,
    system:
      "You are Forma, an assistant for regulatory licensing applications. The user's message needs no document lookup. Reply briefly and helpfully. If they ask anything about regulations, licensing requirements, fees, or forms, do NOT answer from memory — offer to look it up in the ingested documents. If asked what you can help with, describe the ingested corpus:\n\n" +
      corpusBlock(input.corpus),
    messages: [
      ...input.history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: input.question },
    ],
  });
}
