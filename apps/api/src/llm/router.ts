import type { ChatMessage, SearchFilters } from "@forma/shared";
import type { Env } from "../env";
import { anthropicClient, MODELS } from "./anthropic";

export interface RouteDecision {
  needsRetrieval: boolean;
  query: string;
  filters: SearchFilters;
  complexity: "simple" | "complex";
}

interface DocInfo {
  id: string;
  title: string;
  state: string | null;
  license_type: string | null;
}

const ROUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["needsRetrieval", "query", "documentId", "state", "licenseType", "complexity"],
  properties: {
    needsRetrieval: {
      type: "boolean",
      description:
        "true for ANY question about regulations, licensing, fees, forms, or requirements — even if it looks like no ingested document covers it (retrieval + the grounding policy decide that). false ONLY for greetings, thanks, or questions about the assistant itself.",
    },
    query: {
      type: "string",
      description: "Standalone retrieval query rewritten from the conversation",
    },
    documentId: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Restrict retrieval to this document id if the user clearly refers to one",
    },
    state: { anyOf: [{ type: "string" }, { type: "null" }] },
    licenseType: { anyOf: [{ type: "string" }, { type: "null" }] },
    complexity: {
      type: "string",
      enum: ["simple", "complex"],
      description:
        "complex = numerical/table reasoning, eligibility analysis, multi-part; simple = single factual lookup",
    },
  },
} as const;

/**
 * Haiku 4.5 routing pass: decides whether to retrieve, rewrites the query,
 * extracts metadata filters, and classifies complexity for model selection.
 */
export async function routeQuery(
  env: Env,
  messages: ChatMessage[],
  documents: DocInfo[],
  requestFilters?: SearchFilters,
): Promise<RouteDecision> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const fallback: RouteDecision = {
    needsRetrieval: true,
    query: lastUser,
    filters: requestFilters ?? {},
    complexity: "complex",
  };
  if (!lastUser) return { ...fallback, needsRetrieval: false };

  const docList = documents
    .map((d) => `- id=${d.id} title="${d.title}" state=${d.state ?? "-"} license=${d.license_type ?? "-"}`)
    .join("\n");
  const history = messages
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join("\n");

  try {
    const client = anthropicClient(env);
    const response = await client.messages.create({
      model: MODELS.router,
      max_tokens: 300,
      system:
        "You route questions for a regulatory-licensing assistant.\n\n" +
        "needsRetrieval RULE: any question about regulations, licensing, fees, bonds, forms, requirements, or eligibility gets needsRetrieval=true — INCLUDING questions about jurisdictions or topics that do not obviously appear in the document list below (the retrieval layer and grounding policy handle misses; you must not pre-judge coverage). needsRetrieval=false ONLY for greetings, thanks, or questions about the assistant itself.\n\n" +
        "Also: rewrite the question as a standalone search query (resolve pronouns from history) and classify complexity.\n\nAvailable documents:\n" +
        docList,
      messages: [{ role: "user", content: `Conversation:\n${history}\n\nRoute the last user message.` }],
      output_config: { format: { type: "json_schema", schema: ROUTE_SCHEMA as unknown as Record<string, unknown> } },
    });

    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return fallback;
    const parsed = JSON.parse(text) as {
      needsRetrieval: boolean;
      query: string;
      documentId: string | null;
      state: string | null;
      licenseType: string | null;
      complexity: "simple" | "complex";
    };

    // Inferred state/license are NOT applied as hard filters: multi-
    // jurisdiction documents carry state=NULL and a "Georgia" question must
    // still hit the 50-state survey. The rewritten query already carries the
    // jurisdiction lexically/semantically; only explicit caller filters and a
    // clearly-referenced documentId restrict the search.
    // Deterministic backstop: a message with regulatory vocabulary must never
    // skip retrieval, whatever the router said (LLM routing is not exact).
    const regulatory =
      /\b(licen[cs]|fee|bond|regulat|requirement|eligib|form|appl(y|ication)|attach|net worth|deadline|renew|statute|comply|compliance|transmit)/i.test(
        lastUser,
      );

    return {
      needsRetrieval: parsed.needsRetrieval || regulatory,
      query: parsed.query || lastUser,
      filters: {
        ...(parsed.documentId ? { documentId: parsed.documentId } : {}),
        ...(requestFilters ?? {}),
      },
      complexity: parsed.complexity,
    };
  } catch {
    // Routing must never take the chat down — degrade to retrieve-with-Opus.
    return fallback;
  }
}
