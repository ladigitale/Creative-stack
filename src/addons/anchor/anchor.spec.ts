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

  it("dessin joint : exporte le cadre (page) d'un croquis qui en a un, la vue sinon", async () => {
    const store = document.createElement("sonic-store");
    store.id = "balisesPage";
    store.setAttribute("initial", JSON.stringify({ items: [] }));
    store.setAttribute("reducer", '$action.type = "save" ? $merge([$state, {"items": $append($state.items, [$action.payload])}]) : $state');
    document.body.appendChild(store);
    const areas: string[] = [];
    const fake = (id: string, page: boolean) => {
      const d = document.createElement("div") as HTMLDivElement & Record<string, unknown>;
      d.id = id;
      d.doc = { strokes: [1] };
      if (page) { d.pageWidth = 800; d.pageHeight = 600; }
      d.toSvg = (o: { area: string }) => { areas.push(o.area); return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-400 -300 800 600"></svg>'; };
      document.body.appendChild(d);
      return d;
    };
    const a = fake("croquisPage", true), b = fake("croquisVue", false);
    const el = document.createElement("sonic-anchor-ref") as SonicAnchorRef;
    el.setAttribute("target", "balisesPage");
    el.setAttribute("attach", "dessin=#croquisPage autre=#croquisVue");
    document.body.appendChild(el);
    await tick();
    const ref = buildReference(texture(200, 150), [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }]);
    el.stateValue = { ...el.stateValue, reference: ref };
    expect(el.save()).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(areas.sort()).toEqual(["page", "view"]);
    const item = (get("balisesPage") as { items: Array<Record<string, { width?: number }>> }).items[0];
    expect(item.dessin.width).toBe(800);
    [el, a, b, store].forEach((n) => n.remove());
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

describe("sonic-anchor : renfort gyroscope", () => {
  type Internals = { handle(r: unknown, seq: number, t: number, w: number, h: number, e: string): void; running: boolean };
  const found = { found: true, index: 0, corners: [{ x: 120, y: 90 }, { x: 200, y: 90 }, { x: 200, y: 150 }, { x: 120, y: 150 }], matches: 80, inliers: 40, confidence: 0.9, rotation: 0, ms: 5, mode: "detect" };
  const lost = { found: false, index: -1, corners: null, matches: 3, inliers: 0, confidence: 0, rotation: null, ms: 5, mode: "detect" };

  it("zone perdue : coins prédits par la rotation du téléphone, puis abandon après gyro-hold", async () => {
    set("gyOrient", { alpha: 0, beta: 90, gamma: 0, angle: 0 });
    document.body.insertAdjacentHTML("beforeend", `<sonic-anchor id="gy" gravity="gyOrient" smoothing="0" hold="0" gyro-hold="400"></sonic-anchor>`);
    const el = document.getElementById("gy") as unknown as Internals & { updateComplete: Promise<boolean>; remove(): void };
    await el.updateComplete;
    el.running = true;
    el.handle(found, 1, performance.now(), 320, 240, "main");
    const st = () => get("gyState") as { status: string; gyro: boolean; corners: { x: number; y: number }[] | null };
    expect(st().status).toBe("tracking");
    const x0 = st().corners![0].x;
    // le téléphone tourne de 10° vers la gauche : la zone glisse vers la droite de l'image
    set("gyOrient", { alpha: 10, beta: 90, gamma: 0, angle: 0 });
    el.handle(lost, 2, performance.now(), 320, 240, "main");
    expect(st().status).toBe("holding");
    expect(st().gyro).toBe(true);
    expect(st().corners![0].x).toBeGreaterThan(x0 + 0.05);
    await new Promise((r) => setTimeout(r, 450));
    el.handle(lost, 3, performance.now(), 320, 240, "main");
    expect(st().status).toBe("searching");
    expect(st().gyro).toBe(false);
    el.running = false;
    el.remove();
  });

  it("calée sur la vidéo : orientation au moment de la prise de l'image, numéro de cette image publié", async () => {
    set("gy2Orient", { alpha: 0, beta: 90, gamma: 0, angle: 0 });
    document.body.insertAdjacentHTML("beforeend", `<sonic-anchor id="gy2" gravity="gy2Orient" smoothing="0" hold="0"></sonic-anchor>`);
    const el = document.getElementById("gy2") as unknown as Internals & { updateComplete: Promise<boolean>; remove(): void };
    await el.updateComplete;
    el.running = true;
    const t0 = performance.now();
    el.handle(found, 10, t0, 320, 240, "main");
    const st = () => get("gy2State") as { gyro: boolean; frameSeq: number; corners: { x: number; y: number }[] | null };
    const x0 = st().corners![0].x;
    await new Promise((r) => setTimeout(r, 5));
    const shot = performance.now(); // image prise avant que le téléphone ne tourne…
    await new Promise((r) => setTimeout(r, 5));
    set("gy2Orient", { alpha: 20, beta: 90, gamma: 0, angle: 0 }); // …rotation mesurée après
    el.handle(lost, 11, shot, 320, 240, "main");
    expect(st().gyro).toBe(true);
    expect(st().frameSeq).toBe(11);
    // la rotation faite après la prise n'est pas encore à l'image : le contenu ne bouge pas en avance
    expect(st().corners![0].x).toBeCloseTo(x0, 3);
    el.handle(lost, 12, performance.now(), 320, 240, "main");
    expect(st().frameSeq).toBe(12);
    expect(st().corners![0].x).toBeGreaterThan(x0 + 0.1);
    el.running = false;
    el.remove();
  });
});
