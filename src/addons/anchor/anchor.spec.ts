import { describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import "../interactive";
import { buildReference, fitRect, projectionMatrix, type SonicAnchor, type SonicAnchorRef, type SonicAnchorView } from "./index";
import { boxBlur } from "./core/image";

const tick = () => new Promise((r) => setTimeout(r, 0));

function texture(w: number, h: number) {
  const d = new Uint8Array(w * h);
  let s = 12345;
  for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s >>> 16) & 255; }
  return boxBlur({ data: d, width: w, height: h }, 2);
}

describe("sonic-anchor-view", () => {
  it("cale le rectangle de l'image comme object-fit", () => {
    const c = fitRect(400, 300, 300, 400, "cover");
    expect(c.x).toBeCloseTo(-116.667, 2);
    expect(c.w).toBeCloseTo(533.333, 2);
    expect(c.h).toBe(400);
    expect(fitRect(400, 300, 300, 400, "contain")).toEqual({ x: 0, y: 87.5, w: 300, h: 225 });
  });

  it("projette le plan sur les coins (identité pour un rectangle aligné)", () => {
    const m = projectionMatrix(200, 100, [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }])!;
    expect(m).toBe("matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)");
  });

  it("n'affiche rien tant que la zone n'est pas trouvée", async () => {
    const el = document.createElement("sonic-anchor-view") as SonicAnchorView;
    el.setAttribute("anchor", "vueTest");
    document.body.appendChild(el);
    await tick();
    el.onState({ found: false, corners: null, width: 100, height: 100 });
    expect(el.transformFor(100, 100)).toBeNull();
    el.onState({ found: true, width: 100, height: 100, corners: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }] });
    expect(el.transformFor(100, 100)).toMatch(/^matrix3d/);
    el.remove();
  });
});

describe("sonic-anchor", () => {
  it("lit une ou plusieurs références depuis un DataProvider et ignore les illisibles", async () => {
    const ref = buildReference(texture(200, 150), [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }], { id: "porte" });
    set("refsTest", [ref, { v: 1, nope: true }]);
    const el = document.createElement("sonic-anchor") as SonicAnchor;
    el.id = "ancreTest";
    el.setAttribute("reference", "refsTest");
    document.body.appendChild(el);
    await tick();
    const s = get("ancreTestState") as { references: number; error: string; status: string };
    expect(s.references).toBe(1);
    expect(s.error).toMatch(/illisible/);
    expect(s.status).toBe("idle");
    el.start();
    expect((get("ancreTestState") as { status: string }).status).toBe("searching");
    el.stop();
    el.remove();
  });
});

describe("sonic-anchor : entrées enregistrées", () => {
  it("lit les entrées {id, ref, …}, filtre par proximité et publie les champs de l'entrée", async () => {
    const zone = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];
    const ref = buildReference(texture(200, 150), zone);
    set("entreesTest", [
      { id: "ici", lat: 47.39, lon: 0.69, message: "bonjour", ref },
      { id: "loin", lat: 48, lon: 2, ref },
      { id: "sansgps", ref },
    ]);
    set("procheTest", { nearby: [] });
    const el = document.createElement("sonic-anchor") as SonicAnchor;
    el.id = "ancreEntrees";
    el.setAttribute("reference", "entreesTest");
    el.setAttribute("within", "procheTest");
    document.body.appendChild(el);
    await tick();
    expect(el.candidateIds()).toEqual(["ici", "loin", "sansgps"]);
    set("procheTest", { nearby: [{ id: "ici", distance: 4 }] });
    await tick();
    expect(el.candidateIds()).toEqual(["ici", "sansgps"]);
    expect((get("ancreEntreesState") as { references: number }).references).toBe(3);
    el.remove();
  });

  it("essaie aussi les surfaces de remplacement (`refs`) d'une entrée, sous le même id", async () => {
    const zone = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];
    const ref = buildReference(texture(200, 150), zone);
    const ref2 = buildReference(texture(160, 120), zone);
    set("entreesRefs", [{ id: "mur", message: "repeint", ref, refs: [ref2, { pas: "une référence" }] }]);
    const el = document.createElement("sonic-anchor") as SonicAnchor;
    el.id = "ancreRefs";
    el.setAttribute("reference", "entreesRefs");
    document.body.appendChild(el);
    await tick();
    expect(el.candidateIds()).toEqual(["mur"]);
    expect((el as unknown as { refs: unknown[] }).refs).toHaveLength(2);
    const st = get("ancreRefsState") as { references: number; error: string | null };
    expect(st.references).toBe(1);
    expect(st.error).toBeNull();
    el.remove();
  });
});

describe("sonic-anchor-ref", () => {
  it("enregistre la balise dans un store, avec les champs de `extra`", async () => {
    const store = document.createElement("sonic-store");
    store.id = "balisesTest";
    store.setAttribute("initial", JSON.stringify({ items: [] }));
    store.setAttribute("reducer", '$action.type = "save" ? $merge([$state, {"items": $append($state.items, [$action.payload])}]) : $state');
    document.body.appendChild(store);
    set("extraTest", { message: "coucou", effet: "motif" });
    set("voixTest", { last: { url: "data:audio/webm;base64,AAAA", mime: "audio/webm", durS: 1.5 } });
    const el = document.createElement("sonic-anchor-ref") as SonicAnchorRef;
    el.id = "poseSave";
    el.setAttribute("target", "balisesTest");
    el.setAttribute("extra", "extraTest");
    el.setAttribute("attach", "voix=voixTest.last dessin=#absent");
    document.body.appendChild(el);
    await tick();
    expect(el.save()).toBe(false);
    const ref = buildReference(texture(200, 150), [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }]);
    ref.geo = { lat: 47.39, lon: 0.69, accuracy: 6 };
    el.stateValue = { ...el.stateValue, reference: ref };
    expect(el.save()).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const items = (get("balisesTest") as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0].message).toBe("coucou");
    expect(items[0].lat).toBe(47.39);
    expect((items[0].ref as { id: string }).id).toBe(items[0].id);
    expect(items[0].voix).toEqual({ url: "data:audio/webm;base64,AAAA", mime: "audio/webm", durS: 1.5, width: undefined, height: undefined });
    expect(items[0].dessin).toBeUndefined();
    expect((get("poseSaveState") as { saved: number }).saved).toBe(1);
    el.remove();
    store.remove();
  });

  it("publie la zone ordonnée sans photo, et refuse de capturer sans source", async () => {
    set("zoneTest", null);
    const el = document.createElement("sonic-anchor-ref") as SonicAnchorRef;
    el.id = "poseTest";
    el.setAttribute("zone", "zoneTest");
    document.body.appendChild(el);
    await tick();
    el.setZone([{ x: 0.9, y: 0.9 }, { x: 0.1, y: 0.1 }, { x: 0.1, y: 0.9 }, { x: 0.9, y: 0.1 }]);
    expect(get("zoneTest")).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }]);
    expect(el.capture()).toBe(false);
    expect((get("poseTestState") as { status: string }).status).toBe("error");
    el.remove();
  });

  it("une poignée garde le doigt : défilement bloqué pendant le geste, zone publiée au relâchement", async () => {
    set("zoneDrag", null);
    const el = document.createElement("sonic-anchor-ref") as SonicAnchorRef;
    el.id = "poseDrag";
    el.setAttribute("zone", "zoneDrag");
    document.body.appendChild(el);
    (el as unknown as { size: { w: number; h: number } }).size = { w: 400, h: 300 };
    el.requestUpdate();
    await el.updateComplete;
    const svgEl = el.shadowRoot!.querySelector("svg")!;
    svgEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const pe = (type: string, x: number, y: number) => {
      const e = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y }) as MouseEvent & { pointerId: number };
      Object.defineProperty(e, "pointerId", { value: 7 });
      return e as unknown as PointerEvent;
    };
    const touch = () => {
      const t = new Event("touchmove", { bubbles: true, cancelable: true });
      document.dispatchEvent(t);
      return t.defaultPrevented;
    };
    const handle = el.shadowRoot!.querySelector(".handle")!;
    handle.dispatchEvent(pe("pointerdown", 40, 30));
    expect(el.hasAttribute("dragging")).toBe(true);
    expect(touch()).toBe(true);
    svgEl.dispatchEvent(pe("pointermove", 20, 15));
    svgEl.dispatchEvent(pe("pointerup", 20, 15));
    expect(el.hasAttribute("dragging")).toBe(false);
    expect(touch()).toBe(false);
    const z = get("zoneDrag") as Array<{ x: number; y: number }>;
    expect(z[0]).toEqual({ x: 0.05, y: 0.05 });
    el.remove();
  });
});
