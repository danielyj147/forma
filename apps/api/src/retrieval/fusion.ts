/** Pure functions for hybrid fusion — unit-tested in test/fusion.test.ts. */

/**
 * Reciprocal Rank Fusion (Cormack et al. 2009): score(d) = Σ 1/(k + rank_i(d)).
 * Rank-based, so BM25 and cosine scores need no normalization to combine.
 */
export function rrfFuse(
  rankings: Array<Map<string, number>>, // id -> 1-based rank
  k: number,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [id, rank] of ranking) {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  return fused;
}

/** Turn an ordered candidate id list into a 1-based rank map. */
export function toRanks(idsInOrder: string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  idsInOrder.forEach((id, i) => {
    if (!ranks.has(id)) ranks.set(id, i + 1);
  });
  return ranks;
}

/**
 * Linear time-decay on filing_date: multiplier = max(floor, 1 - λ·ageYears).
 * Chunks without a filing_date are left untouched (multiplier 1) — absence of
 * a date is not evidence of staleness.
 */
export function applyTimeDecay(
  scores: Map<string, number>,
  filingDates: Map<string, string | null | undefined>,
  lambda: number,
  floor: number,
  now: Date,
): Map<string, number> {
  if (lambda <= 0) return new Map(scores);
  const out = new Map<string, number>();
  for (const [id, score] of scores) {
    const dateStr = filingDates.get(id);
    let multiplier = 1;
    if (dateStr) {
      const filed = Date.parse(dateStr);
      if (!Number.isNaN(filed)) {
        const ageYears = Math.max(0, (now.getTime() - filed) / (365.25 * 24 * 3600 * 1000));
        multiplier = Math.max(floor, 1 - lambda * ageYears);
      }
    }
    out.set(id, score * multiplier);
  }
  return out;
}

/**
 * Build a safe FTS5 MATCH expression from free text: bare tokens are quoted
 * (so `?`, `-`, `.` etc. can't break MATCH syntax) and OR-joined for recall —
 * the fused ranking, not boolean AND, decides relevance.
 */
export function toFtsQuery(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .slice(0, 32); // keep MATCH expressions bounded
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
