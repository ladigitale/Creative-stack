import { afterEach, describe, expect, it } from "vitest";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./store";
import { dispatch } from "./registry";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(id: string, reducer: string): Promise<HTMLElement> {
  const el = document.createElement("sonic-store");
  el.id = id;
  el.setAttribute("initial", JSON.stringify({ list: [1, 2, 3, 4], seed: 5 }));
  el.setAttribute("reducer", reducer);
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

describe("sonic-store : réducteur pur", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("$shuffle est refusé (état inchangé), $shuffled à graine est accepté", async () => {
    await mount("pur1", "$action.type = 'mix' ? $merge([$state, {'list': $shuffle($state.list)}]) : $state");
    dispatch("pur1", { type: "mix" });
    await wait(50);
    expect((get("pur1") as { list: number[] }).list).toEqual([1, 2, 3, 4]);

    await mount("pur2", "$action.type = 'mix' ? ($s := $shuffled($state.list, $state.seed); $merge([$state, {'list': $s.value, 'seed': $s.seed}])) : $state");
    dispatch("pur2", { type: "mix" });
    await wait(50);
    const s = get("pur2") as { list: number[]; seed: number };
    expect([...s.list].sort()).toEqual([1, 2, 3, 4]);
    expect(s.seed).not.toBe(5);
  });
});
