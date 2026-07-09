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
      description: "false only for greetings/meta-questions that need no document knowledge",
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
        "You route questions for a regulatory-licensing assistant. Decide whether the question needs document retrieval, rewrite it as a standalone search query (resolve pronouns from history), pick metadata filters only when the user clearly implies them, and classify complexity.\n\nAvailable documents:\n" +
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

    return {
      needsRetrieval: parsed.needsRetrieval,
      query: parsed.query || lastUser,
      filters: {
        // explicit request filters win over inferred ones
        ...(parsed.documentId ? { documentId: parsed.documentId } : {}),
        ...(parsed.state ? { state: parsed.state } : {}),
        ...(parsed.licenseType ? { licenseType: parsed.licenseType } : {}),
        ...(requestFilters ?? {}),
      },
      complexity: parsed.complexity,
    };
  } catch {
    // Routing must never take the chat down — degrade to retrieve-with-Opus.
    return fallback;
  }
}
