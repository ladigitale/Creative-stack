import { describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";

describe("sonic-map : DataProvider en chemin pointé", () => {
  it("dp('a.b') reçoit la valeur quand le parent est réécrit", () => {
    const got: unknown[] = [];
    const pub = dp("mapDpSpec.points") as unknown as { onAssign(f: (v: unknown) => void, now?: boolean): void };
    pub.onAssign((v) => got.push(JSON.parse(JSON.stringify(v ?? null))), false);
    set("mapDpSpec", { total: 1, points: [{ id: "a", lat: 1, lon: 2 }] });
    expect(got.at(-1)).toEqual([{ id: "a", lat: 1, lon: 2 }]);
  });
});
