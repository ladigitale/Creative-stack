import { describe, expect, it } from "vitest";
import { cosine, rankBySimilarity } from "./similarity";

describe("similarity", () => {
  it("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBeNull();
    expect(cosine(null, [1])).toBeNull();
  });

  it("rankBySimilarity : classe, ignore les vecteurs absents, coupe au top N", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const vectors = [[0, 1], null, [1, 0.1]];
    const ranked = rankBySimilarity(items, vectors, [1, 0], 5);
    expect(ranked.map((r) => r.id)).toEqual(["c", "a"]);
    expect(ranked[0]._score).toBeGreaterThan(0.99);
    expect(rankBySimilarity(items, vectors, [1, 0], 1)).toHaveLength(1);
  });
});
