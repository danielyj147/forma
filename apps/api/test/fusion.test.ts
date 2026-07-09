import { describe, expect, it } from "vitest";
import { applyTimeDecay, rrfFuse, toFtsQuery, toRanks } from "../src/retrieval/fusion";

describe("rrfFuse", () => {
  it("scores 1/(k+rank) summed across rankings", () => {
    const dense = toRanks(["a", "b", "c"]);
    const bm25 = toRanks(["b", "a"]);
    const fused = rrfFuse([dense, bm25], 60);
    // a: 1/61 + 1/62 ; b: 1/62 + 1/61 → tie; c: 1/63
    expect(fused.get("a")).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused.get("b")).toBeCloseTo(fused.get("a")!, 10);
    expect(fused.get("c")).toBeCloseTo(1 / 63, 10);
  });

  it("ranks doc found by both legs above docs found by one", () => {
    const dense = toRanks(["x", "both"]);
    const bm25 = toRanks(["y", "both"]);
    const fused = rrfFuse([dense, bm25], 60);
    expect(fused.get("both")!).toBeGreaterThan(fused.get("x")!);
    expect(fused.get("both")!).toBeGreaterThan(fused.get("y")!);
  });

  it("handles a single ranking (dense-only / bm25-only modes)", () => {
    const fused = rrfFuse([toRanks(["a", "b"])], 60);
    expect([...fused.keys()]).toEqual(["a", "b"]);
    expect(fused.get("a")!).toBeGreaterThan(fused.get("b")!);
  });
});

describe("toRanks", () => {
  it("is 1-based and keeps first occurrence on duplicates", () => {
    const ranks = toRanks(["a", "b", "a"]);
    expect(ranks.get("a")).toBe(1);
    expect(ranks.get("b")).toBe(2);
  });
});

describe("applyTimeDecay", () => {
  const now = new Date("2026-07-01T00:00:00Z");

  it("leaves scores untouched when lambda is 0", () => {
    const scores = new Map([["a", 1]]);
    const out = applyTimeDecay(scores, new Map([["a", "2010-01-01"]]), 0, 0.5, now);
    expect(out.get("a")).toBe(1);
  });

  it("applies linear decay by age in years", () => {
    const scores = new Map([["a", 1]]);
    const dates = new Map([["a", "2024-07-01"]]); // ~2 years old
    const out = applyTimeDecay(scores, dates, 0.1, 0.5, now);
    expect(out.get("a")!).toBeCloseTo(1 - 0.1 * 2, 2);
  });

  it("clamps at the floor for very old documents", () => {
    const scores = new Map([["a", 1]]);
    const dates = new Map([["a", "2000-01-01"]]);
    const out = applyTimeDecay(scores, dates, 0.1, 0.5, now);
    expect(out.get("a")).toBe(0.5);
  });

  it("does not decay chunks with no filing_date", () => {
    const scores = new Map([["a", 1]]);
    const out = applyTimeDecay(scores, new Map([["a", null]]), 0.2, 0.5, now);
    expect(out.get("a")).toBe(1);
  });

  it("does not boost future-dated documents", () => {
    const scores = new Map([["a", 1]]);
    const out = applyTimeDecay(scores, new Map([["a", "2030-01-01"]]), 0.1, 0.5, now);
    expect(out.get("a")).toBe(1);
  });
});

describe("toFtsQuery", () => {
  it("quotes tokens and joins with OR", () => {
    expect(toFtsQuery("surety bond amount")).toBe('"surety" OR "bond" OR "amount"');
  });

  it("neutralizes FTS5 operators and punctuation", () => {
    expect(toFtsQuery('fee* AND "MU1" NEAR(x) what-is?')).toBe(
      '"fee" OR "and" OR "mu1" OR "near" OR "x" OR "what" OR "is"',
    );
  });

  it("returns null for queries with no indexable tokens", () => {
    expect(toFtsQuery("?! —")).toBeNull();
    expect(toFtsQuery("")).toBeNull();
  });

  it("caps token count", () => {
    const q = toFtsQuery(Array.from({ length: 50 }, (_, i) => `w${i}`).join(" "))!;
    expect(q.split(" OR ")).toHaveLength(32);
  });
});
