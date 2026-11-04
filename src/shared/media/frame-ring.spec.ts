import { describe, expect, it } from "vitest";
import { FrameRing } from "./frame-ring";

function fill(r: FrameRing<{ id: number }>, seqs: number[], dt = 33) {
  for (const s of seqs) r.push(s, s * dt, (rec) => rec ?? { id: s });
}

describe("FrameRing", () => {
  it("retrouve l'image par numéro : exacte, sinon la précédente, sinon la plus ancienne", () => {
    const r = new FrameRing<{ id: number }>(10);
    fill(r, [10, 11, 13, 14]);
    expect(r.bySeq(13)?.seq).toBe(13);
    expect(r.bySeq(12)?.seq).toBe(11);
    expect(r.bySeq(99)?.seq).toBe(14);
    expect(r.bySeq(1)?.seq).toBe(10);
  });

  it("retrouve l'image par date", () => {
    const r = new FrameRing<{ id: number }>(10);
    fill(r, [1, 2, 3, 4], 100);
    expect(r.byTime(250)?.seq).toBe(2);
    expect(r.byTime(0)?.seq).toBe(1);
    expect(r.byTime(10_000)?.seq).toBe(4);
  });

  it("borne la taille, recycle la valeur retirée et ne retire pas l'image épinglée", () => {
    const r = new FrameRing<{ id: number }>(3);
    fill(r, [1, 2, 3]);
    r.push(4, 4, (rec) => rec ?? { id: 4 }, 1);
    expect(r.size).toBe(3);
    expect(r.oldest()?.seq).toBe(1); // épinglée : on retire la 2
    expect(r.bySeq(2)?.seq).toBe(1);
    const third = r.bySeq(3)!.value;
    r.push(5, 5, (rec) => rec ?? { id: 5 }, 1);
    expect(r.newest()!.value).toBe(third); // la valeur retirée (seq 3) est réutilisée
    expect(r.oldest()?.seq).toBe(1);
  });

  it("vide", () => {
    const r = new FrameRing<{ id: number }>(3);
    expect(r.newest()).toBeNull();
    expect(r.bySeq(1)).toBeNull();
    fill(r, [1]);
    r.clear();
    expect(r.size).toBe(0);
  });
});
