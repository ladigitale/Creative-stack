import { describe, expect, it } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { publisherAt } from "./dp-path";

describe("publisherAt", () => {
  it("un nom simple garde l'instance de PublisherManager.get", () => {
    expect(publisherAt("dpPathSimple")).toBe(PublisherManager.get("dpPathSimple"));
  });

  it("un nom pointé suit la clé du DataProvider parent", () => {
    set("dpPathParent", { carte: { points: [1, 2] } });
    expect(JSON.parse(JSON.stringify(publisherAt("dpPathParent.carte.points").get()))).toEqual([1, 2]);
    set("dpPathParent", { carte: { points: [3] } });
    expect(JSON.parse(JSON.stringify(publisherAt("dpPathParent.carte.points").get()))).toEqual([3]);
  });
});
