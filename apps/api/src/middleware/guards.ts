import type { Context, Next } from "hono";
import type { Env } from "../env";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Soft cost guards for a public demo (KV-backed, eventually consistent —
 * good enough to bound worst-case Anthropic spend, not a security boundary):
 * per-IP hourly cap + global daily cap.
 */
const PER_IP_HOURLY = 40;
const GLOBAL_DAILY = 400;

export async function rateLimit(c: AppContext, next: Next): Promise<Response | void> {
  // Authenticated eval/ingest traffic (Bearer INGEST_TOKEN) is exempt — the
  // parameter sweeps in scripts/evaluate.py issue hundreds of searches.
  const header = c.req.header("authorization") ?? "";
  if (c.env.INGEST_TOKEN && header === `Bearer ${c.env.INGEST_TOKEN}`) {
    return next();
  }

  const now = new Date();
  const hour = now.toISOString().slice(0, 13); // yyyy-mm-ddThh
  const day = now.toISOString().slice(0, 10);
  const ip = c.req.header("cf-connecting-ip") ?? "local";

  const ipKey = `rl:ip:${ip}:${hour}`;
  const globalKey = `rl:global:${day}`;

  const [ipCount, globalCount] = await Promise.all([
    c.env.RL.get(ipKey).then((v) => Number(v ?? 0)),
    c.env.RL.get(globalKey).then((v) => Number(v ?? 0)),
  ]);

  if (ipCount >= PER_IP_HOURLY) {
    return c.json({ error: "Rate limit reached — try again in a bit." }, 429);
  }
  if (globalCount >= GLOBAL_DAILY) {
    return c.json({ error: "The demo has hit its daily usage cap. Back tomorrow!" }, 429);
  }

  await Promise.all([
    c.env.RL.put(ipKey, String(ipCount + 1), { expirationTtl: 7200 }),
    c.env.RL.put(globalKey, String(globalCount + 1), { expirationTtl: 172800 }),
  ]);
  await next();
}

/** Optional access gate: active only when the ACCESS_CODE secret is set (prod). */
export async function accessCode(c: AppContext, next: Next): Promise<Response | void> {
  if (c.env.ACCESS_CODE && c.req.header("x-access-code") !== c.env.ACCESS_CODE) {
    return c.json({ error: "Access code required.", code: "access_code_required" }, 401);
  }
  await next();
}

/** Admin ingestion auth: constant Bearer token provisioned by `npm run setup`. */
export async function ingestAuth(c: AppContext, next: Next): Promise<Response | void> {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!c.env.INGEST_TOKEN || !timingSafeEqual(token, c.env.INGEST_TOKEN)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
