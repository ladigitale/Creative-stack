import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./store";
import { dispatch } from "./registry";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Monte un sonic-store et attend son démarrage. */
async function mount(id: string, persist: string): Promise<HTMLElement> {
  const el = document.createElement("sonic-store");
  el.id = id;
  el.setAttribute("initial", JSON.stringify({ n: 0 }));
  el.setAttribute("reducer", '$action.type = "inc" ? {"n": $state.n + 1} : $state');
  if (persist) el.setAttribute("persist", persist);
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

describe("sonic-store persist", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.useRealTimers();
  });

  it("enregistre après une action et reprend l'état au démarrage suivant", async () => {
    const a = await mount("compteur1", "test:compteur1");
    dispatch("compteur1", { type: "inc" });
    dispatch("compteur1", { type: "inc" });
    await wait(450);
    expect(JSON.parse(localStorage.getItem("test:compteur1")!)).toEqual({ n: 2 });
    a.remove();
    await mount("compteur1", "test:compteur1");
    expect((get("compteur1") as { n: number }).n).toBe(2);
  });

  it("@reset revient à initial et l'enregistre ; sans persist rien n'est écrit", async () => {
    localStorage.setItem("test:compteur2", JSON.stringify({ n: 7 }));
    await mount("compteur2", "test:compteur2");
    expect((get("compteur2") as { n: number }).n).toBe(7);
    dispatch("compteur2", { type: "@reset" });
    await wait(450);
    expect(JSON.parse(localStorage.getItem("test:compteur2")!)).toEqual({ n: 0 });
    await mount("compteur3", "");
    dispatch("compteur3", { type: "inc" });
    await wait(450);
    expect(localStorage.length).toBe(1);
  });

  it("ignore une sauvegarde illisible ou d'une autre forme", async () => {
    localStorage.setItem("test:compteur4", "{pas du json");
    await mount("compteur4", "test:compteur4");
    expect((get("compteur4") as { n: number }).n).toBe(0);
    localStorage.setItem("test:compteur5", JSON.stringify([1, 2]));
    await mount("compteur5", "test:compteur5");
    expect((get("compteur5") as { n: number }).n).toBe(0);
  });

  it("history-skip : ces actions ne s'annulent pas", async () => {
    const el = document.createElement("sonic-store");
    el.id = "compteur6";
    el.setAttribute("initial", JSON.stringify({ n: 0, sel: "" }));
    el.setAttribute("reducer", '$action.type = "inc" ? $merge([$state, {"n": $state.n + 1}]) : $action.type = "select" ? $merge([$state, {"sel": $action.payload}]) : $state');
    el.setAttribute("history", "10");
    el.setAttribute("history-skip", "select");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    dispatch("compteur6", { type: "inc" });
    dispatch("compteur6", { type: "select", payload: "lit1" });
    await wait(50);
    dispatch("compteur6", { type: "@undo" });
    await wait(50);
    // l'annulation porte sur inc (n revient à 0) ; la sélection n'est pas une étape
    expect((get("compteur6") as { n: number }).n).toBe(0);
  });
});
