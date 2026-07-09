import { Hono } from "hono";
import type { SearchRequest, SearchResponse } from "@forma/shared";
import type { Env } from "../env";
import { retrieve } from "../retrieval/search";
import { accessCode, rateLimit } from "../middleware/guards";

/**
 * Retrieval endpoint. Doubles as the eval harness's instrument: `config`
 * overrides any retrieval parameter per-request and `debug: true` returns
 * per-stage ranks/scores/timings (SearchDebug).
 */
export const search = new Hono<{ Bindings: Env }>();

search.post("/api/search", accessCode, rateLimit, async (c) => {
  const body = (await c.req.json().catch(() => null)) as SearchRequest | null;
  if (!body?.query || typeof body.query !== "string") {
    return c.json({ error: "Missing 'query'" }, 400);
  }

  const { results, debug } = await retrieve(
    c.env,
    body.query,
    body.filters,
    body.config,
    body.debug === true,
  );
  const response: SearchResponse = { results, ...(debug ? { debug } : {}) };
  return c.json(response);
});
