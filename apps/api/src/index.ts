import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { chat } from "./routes/chat";
import { search } from "./routes/search";
import { documents } from "./routes/documents";
import { admin } from "./routes/admin";

const app = new Hono<{ Bindings: Env }>();

// CORS only matters in local dev (vite on :5173 → wrangler on :8787);
// deployed, the SPA and API share an origin.
app.use(
  "/api/*",
  cors({
    origin: (origin) => (origin?.startsWith("http://localhost") ? origin : undefined),
    allowHeaders: ["content-type", "authorization", "x-access-code"],
  }),
);

app.get("/api/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));
app.route("/", documents);
app.route("/", search);
app.route("/", chat);
app.route("/", admin);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("unhandled error:", err);
  // Message (not stack) included: this is a demo API and opaque 500s cost
  // more debugging time than the message could ever leak.
  return c.json({ error: "Internal error", detail: err instanceof Error ? err.message : String(err) }, 500);
});

export default app;
