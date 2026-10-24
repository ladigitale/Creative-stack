import { describe, expect, it, vi } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { life } from "./life";

type Aliasable = { _proxies_: Map<string, unknown> };

describe("life.bindFormProvider : sous-clé nodes", () => {
  it("réagit quand la source aliasée par sonic-mix sous `nodes` est réassignée, puis se désabonne", () => {
    const onFormMutation = vi.fn();
    const host = { dataProvider: "life-nodes-scene", formPublisher: null, onFormMutation } as never;
    // sonic-mix : `{"nodes": "life-nodes-world"}` aliase le proxy source comme enfant `nodes` (pas de remontée vers la racine).
    const scene = PublisherManager.get("life-nodes-scene") as unknown as Aliasable;
    const source = PublisherManager.get("life-nodes-world") as unknown as { set: (v: unknown) => void };
    scene._proxies_.set("nodes", source);
    life.bindFormProvider(host);
    const calls = onFormMutation.mock.calls.length; // appel initial
    source.set({ cue: { x: 1, y: 2 } });
    expect(onFormMutation.mock.calls.length).toBeGreaterThan(calls);
    life.unbindFormProvider(host);
    const after = onFormMutation.mock.calls.length;
    source.set({ cue: { x: 3, y: 4 } });
    expect(onFormMutation.mock.calls.length).toBe(after);
  });
});
