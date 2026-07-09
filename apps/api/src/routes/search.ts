import { Hono } from "hono";
import type { SearchResponse } from "@forma/shared";
import type { Env } from "../env";
import { retrieve } from "../retrieval/search";
import { accessCode, rateLimit } from "../middleware/guards";
import { parseBody, searchRequestSchema } from "../validation";

/**
 * Retrieval endpoint. Doubles as the eval harness's instrument: `config`
 * overrides any retrieval parameter per-request and `debug: true` returns
 * per-stage ranks/scores/timings (SearchDebug).
 */
export const search = new Hono<{ Bindings: Env }>();

search.post("/api/search", accessCode, rateLimit, async (c) => {
  const [body, err] = await parseBody(c.req.raw, searchRequestSchema);
  if (err) return c.json(err, 400);

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
