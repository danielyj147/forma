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
 * US state abbreviation <-> name expansion. Regulatory documents flip freely
 * between "NY" and "New York"; BM25 can't bridge that lexically, so the query
 * builder does — deterministic, domain-level (not document-specific).
 */
const STATE_NAMES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
  ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi",
  mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire",
  nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina",
  nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania",
  ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee",
  tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
  wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
};
const STATE_ABBREVS = new Map(Object.entries(STATE_NAMES).map(([ab, name]) => [name, ab]));

/** Abbreviations that are also English words — expand only when UPPERCASE. */
const AMBIGUOUS_ABBREVS = new Set([
  "al", "ar", "co", "de", "hi", "id", "in", "la", "ma", "md", "me", "mi", "mo",
  "mt", "ne", "oh", "ok", "or", "pa", "wa",
]);

/**
 * Build a safe FTS5 MATCH expression from free text: bare tokens are quoted
 * (so `?`, `-`, `.` etc. can't break MATCH syntax) and OR-joined for recall —
 * the fused ranking, not boolean AND, decides relevance. State abbreviations
 * expand to full names (and vice versa) so "in NY" matches "New York" rows.
 */
export function toFtsQuery(query: string): string | null {
  const lowered = query.toLowerCase();
  const tokens = lowered
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .slice(0, 32); // keep MATCH expressions bounded
  if (tokens.length === 0) return null;

  const terms = new Set<string>(tokens.map((t) => `"${t}"`));
  for (const token of tokens) {
    const name = STATE_NAMES[token];
    if (!name) continue;
    // "in"/"or"/"me" etc. are common words — treat as a state only if the user
    // wrote them uppercase ("IN"), the convention for state abbreviations.
    if (AMBIGUOUS_ABBREVS.has(token) && !new RegExp(`\\b${token.toUpperCase()}\\b`).test(query)) {
      continue;
    }
    terms.add(`"${name}"`); // quoted multi-word string = FTS5 phrase
  }
  for (const [name, abbrev] of STATE_ABBREVS) {
    if (lowered.includes(name)) terms.add(`"${abbrev}"`);
  }
  return [...terms].join(" OR ");
}
