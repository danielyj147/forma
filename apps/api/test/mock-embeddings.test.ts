import { describe, expect, it } from "vitest";
import { mockEmbed, MOCK_DIM } from "../src/retrieval/embeddings";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both are unit-normalized
}

describe("mockEmbed (offline dev embeddings)", () => {
  it("is deterministic and unit-normalized", () => {
    const a = mockEmbed("surety bond requirements for money transmitters");
    const b = mockEmbed("surety bond requirements for money transmitters");
    expect(a).toEqual(b);
    expect(a).toHaveLength(MOCK_DIM);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("scores related text above unrelated text", () => {
    const query = mockEmbed("what is the application fee");
    const related = mockEmbed("the application fee is $500 payable to the department");
    const unrelated = mockEmbed("zebra migrations across the serengeti happen yearly");
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });
});
