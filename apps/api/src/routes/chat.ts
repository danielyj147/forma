import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { ChatEvent, ChatRequest } from "@forma/shared";
import type { Env } from "../env";
import { retrieve } from "../retrieval/search";
import { routeQuery } from "../llm/router";
import { buildCitations, streamAnswer, streamSmallTalk } from "../llm/generate";
import { MODELS } from "../llm/anthropic";
import { accessCode, rateLimit } from "../middleware/guards";

export const chat = new Hono<{ Bindings: Env }>();

chat.post("/api/chat", accessCode, rateLimit, async (c) => {
  const body = (await c.req.json().catch(() => null)) as ChatRequest | null;
  const lastUser = body?.messages?.filter((m) => m.role === "user").at(-1);
  if (!lastUser?.content) return c.json({ error: "No user message" }, 400);
  const messages = body!.messages;

  return streamSSE(c, async (stream) => {
    const emit = (event: ChatEvent) => stream.writeSSE({ data: JSON.stringify(event) });

    try {
      // 1. Route (Haiku): retrieval? filters? complexity?
      const docs = await c.env.DB.prepare(
        "SELECT id, title, state, license_type FROM documents",
      ).all<{ id: string; title: string; state: string | null; license_type: string | null }>();
      const route = await routeQuery(c.env, messages, docs.results, body!.filters);

      const forced = body!.forceModel;
      const modelKind = forced ?? (route.complexity === "simple" ? "haiku" : "opus");
      await emit({
        type: "routing",
        needsRetrieval: route.needsRetrieval,
        query: route.needsRetrieval ? route.query : undefined,
        model: modelKind === "opus" ? MODELS.complex : MODELS.simple,
      });

      const history = messages.slice(0, -1);

      // 2. No-retrieval path
      if (!route.needsRetrieval) {
        const s = streamSmallTalk(c.env, {
          question: lastUser.content,
          history,
          model: "haiku",
        });
        for await (const delta of textDeltas(s)) await emit({ type: "delta", text: delta });
        const final = await s.finalMessage();
        await emit({
          type: "done",
          usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
        });
        return;
      }

      // 3. Retrieve → cite → generate grounded answer
      const { results } = await retrieve(c.env, route.query, route.filters);
      const citations = buildCitations(results);
      await emit({ type: "sources", citations });

      const s = streamAnswer(c.env, {
        question: lastUser.content,
        history,
        results,
        formContext: body!.formContext,
        model: modelKind,
      });
      for await (const delta of textDeltas(s)) await emit({ type: "delta", text: delta });
      const final = await s.finalMessage();
      await emit({
        type: "done",
        usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
      });
    } catch (err) {
      await emit({ type: "error", message: err instanceof Error ? err.message : "Unexpected error" });
    }
  });
});

async function* textDeltas(stream: MessageStream) {
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
