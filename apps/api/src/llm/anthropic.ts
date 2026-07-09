import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";

/**
 * Model policy (CLAUDE.md / ADR-4):
 *  - Haiku 4.5: routing, simple factual lookups (cost control)
 *  - Opus 4.8: complex/numerical/table reasoning and grounded generation
 * Opus 4.8 does not accept sampling params (temperature/top_p/top_k) — steer
 * with prompting only.
 */
export const MODELS = {
  router: "claude-haiku-4-5",
  simple: "claude-haiku-4-5",
  complex: "claude-opus-4-8",
} as const;

export function anthropicClient(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}
