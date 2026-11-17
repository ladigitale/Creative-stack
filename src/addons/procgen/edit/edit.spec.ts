import { describe, expect, it, vi } from "vitest";
import { rectPenetration, searchFree, quarterGap } from "../../../shared/free-place";
import { type PlaceCtx, arrangeAt, hitsAt, moverFor, placeCtx, restY, snapShift } from "./arrange";
import { Gesture, type GestureCmd } from "./gesture";
import { composeScene, type Recipe } from "../scene/compose";
import { ProcgenView } from "../render/view";
import { SonicProcgen } from "../procgen";

const flat = (obstacles: PlaceCtx["obstacles"] = [], extra: Partial<PlaceCtx> = {}): PlaceCtx => ({ size: [40, 40], height: () => 0, waterLevel: null, pathInfo: null, obstacles, ...extra });
const box = (id: string, x: number, z: number, hx: number, hz: number, yaw = 0, wall = false) => ({ id, rect: { x, z, hx, hz, yaw }, wall });

describe("free-place (partagé avec sonic-3d)", () => {
  it("recouvrement de rectangles orientés", () => {
    expect(rectPenetration({ x: 0, z: 0, hx: 1, hz: 1, yaw: 0 }, { x: 1.5, z: 0, hx: 1, hz: 1, yaw: 0 })).toBeCloseTo(0.5);
    expect(rectPenetration({ x: 0, z: 0, hx: 1, hz: 1, yaw: 0 }, { x: 2.1, z: 0, hx: 1, hz: 1, yaw: 0 })).toBe(0);
    // carré tourné de 45° : son coin entre de √2 - 1 dans le voisin
    expect(rectPenetration({ x: 0, z: 0, hx: 1, hz: 1, yaw: Math.PI / 4 }, { x: 2.2, z: 0, hx: 1, hz: 1, yaw: 0 })).toBeCloseTo(Math.SQRT2 + 1 - 2.2, 3);
    expect(quarterGap(0, Math.PI / 2)).toBeCloseTo(0);
    expect(quarterGap(0.1, Math.PI)).toBeCloseTo(0.1);
  });

  it("searchFree : anneaux croissants, première source d'abord", () => {
    const r = searchFree<number>([(d) => d], (d) => d >= 0.3, { step: 0.1, max: 1 });
    expect(r?.pose).toBeCloseTo(0.3);
    expect(r?.index).toBe(0);
    expect(searchFree<number>([() => null, (d) => d], (d) => d > 0.5, { step: 0.25, max: 1 })?.index).toBe(1);
    expect(searchFree<number>([(d) => d], () => false, { step: 0.5, max: 1 })).toBeNull();
  });
});

describe("rangement procgen", () => {
  const banc = moverFor("banc.0", "seat", 0.8, 0.3, 0);

  it("sans voisin : grille de 5 cm, posé sur le relief", () => {
    const r = arrangeAt(flat([], { height: () => 1 }), banc, 1.234, -2.018);
    expect([r.x, r.z]).toEqual([1.25, -2]);
    expect(r.y).toBeCloseTo(0.98);
    expect(r.valid).toBe(true);
    expect(r.snaps).toContain("grille");
  });

  it("dos au mur : un bâtiment derrière à moins de 30 cm attire le dos de l'objet, cap gardé", () => {
    // maison dont la façade est en z = -1 ; le banc visé à 20 cm devant
    const ctx = flat([box("maison.0", 0, -4, 3, 3, 0, true)]);
    const r = arrangeAt(ctx, banc, 0.5, -0.5);
    expect(r.z).toBeCloseTo(-0.7, 3);
    expect(r.yaw).toBe(0);
    expect(r.snaps).toContain("contact");
    // un simple voisin (pas un mur) n'attire qu'à 8 cm
    expect(snapShift(flat([box("caisse", 0, -4, 3, 3)]), banc, 0.5, -0.5, 0).snaps).toEqual([]);
  });

  it("bords alignés sur un voisin parallèle", () => {
    const ctx = flat([box("banc.1", 3, 0.05, 0.8, 0.3)]);
    const r = arrangeAt(ctx, banc, 0, 0);
    expect(r.z).toBeCloseTo(0.05, 3);
    expect(r.snaps).toContain("aligne-z");
  });

  it("collision : glisse vers la place libre la plus proche ; plus de place : invalide", () => {
    const ctx = flat([box("rocher.0", 0, 0, 1, 1)]);
    expect(hitsAt(ctx, banc, 0, 0)).toEqual(["rocher.0"]);
    const r = arrangeAt(ctx, banc, 0.2, 0);
    expect(r.valid).toBe(true);
    expect(r.snaps).toContain("deplace");
    expect(hitsAt(ctx, banc, r.x, r.z)).toEqual([]);
    expect(Math.hypot(r.x - 0.2, r.z)).toBeLessThan(1.6);
    const full = flat([box("dalle", 0, 0, 30, 30)]);
    const bad = arrangeAt(full, banc, 0, 0);
    expect(bad.valid).toBe(false);
    expect(bad.hits).toContain("dalle");
  });

  it("bords de scène, eau, chaussée", () => {
    const ctx = flat([], { size: [10, 10] });
    const r = arrangeAt(ctx, banc, 9, 0);
    expect(r.x).toBeCloseTo(4.2, 3);
    expect(r.snaps).toContain("dedans");
    const lac = flat([], { waterLevel: 0, height: (x) => (x > 2 ? -1 : 0.5) });
    expect(hitsAt(lac, banc, 4, 0)).toContain("eau");
    const bateau = moverFor("bateau.0", "prop", 1, 2, 0, { onWater: true });
    expect(hitsAt(lac, bateau, 0, 0)).toContain("terre");
    expect(hitsAt(lac, bateau, 6, 0)).toEqual([]);
    expect(restY(lac, bateau, 6, 0)).toBeCloseTo(-0.15);
    const rue = flat([], { pathInfo: (x) => ({ d: Math.abs(x) - 2, kind: "street", id: "rue" }) });
    expect(hitsAt(rue, banc, 0, 0)).toEqual(["rue"]);
    expect(hitsAt(rue, banc, 3, 0)).toEqual([]);
    expect(hitsAt(rue, moverFor("x", "prop", 0.5, 0.5, 0, { onPath: true }), 0, 0)).toEqual([]);
  });

  it("scène composée : emprises par instance, tronçons de clôture, couches et rangs", () => {
    const recipe: Recipe = {
      size: [30, 30],
      ground: false,
      layers: [
        { id: "banc", gen: "seat.parkbench", place: { at: [[0, 0], { x: 4, z: 0, yaw: 90 }] } },
        { id: "rochers", gen: "rock", count: 3, place: { grid: [3, 1], spacing: [3, 3], origin: [0, 8] } },
        { id: "haie", gen: "wall", params: { kind: "hedge", points: [[-10, -5], [10, -5]] }, place: { at: [[0, 0]] } },
      ],
    };
    const m = composeScene({ recipe, seed: 1 });
    const b1 = m.objects.find((o) => o.id === "banc.1")!;
    expect(b1.place).toBe("at");
    expect(b1.index).toBe(1);
    expect(m.objects.find((o) => o.id === "rochers.0")?.place).toBe("grid");
    const haie = m.objects.find((o) => o.id === "haie.0")!;
    expect(haie.blockers?.length).toBeGreaterThan(0);
    const ctx = placeCtx(m, new Set(["banc.0"]));
    expect(ctx.obstacles.some((o) => o.id === "banc.0")).toBe(false);
    // la haie gêne le long de son tracé, pas au centre de la scène
    expect(hitsAt(ctx, moverFor("t", "seat", 0.5, 0.3, 0), 0, -5)).toContain("haie.0");
    expect(hitsAt(ctx, moverFor("t", "seat", 0.5, 0.3, 0), -6, 3)).toEqual([]);
  });
});

describe("gestes", () => {
  const kinds = (c: GestureCmd[]) => c.map((x) => x.kind);

  it("tap court : sélection ; glisser sur le vide : orbite", () => {
    const g = new Gesture();
    g.down(1, 10, 10, 0, 0, () => null);
    expect(kinds(g.up(1, 12, 11, 120))).toEqual(["tap"]);
    g.down(1, 10, 10, 0, 0, () => null);
    expect(g.move(1, 12, 10)).toEqual([]);
    expect(kinds(g.move(1, 30, 10))).toEqual(["orbit"]);
    expect(g.up(1, 30, 10, 200)).toEqual([]);
    // trop long : pas un tap
    g.down(1, 10, 10, 0, 0, () => null);
    expect(g.up(1, 10, 10, 600)).toEqual([]);
  });

  it("objet saisissable : dragStart au-delà de 4 px, drag, dragEnd ; un tap sur lui reste un tap", () => {
    const g = new Gesture();
    const can = vi.fn(() => "drag" as const);
    g.down(1, 10, 10, 0, 0, can);
    expect(can).toHaveBeenCalledTimes(1);
    expect(g.move(1, 12, 10)).toEqual([]);
    expect(kinds(g.move(1, 20, 10))).toEqual(["dragStart", "drag"]);
    expect(kinds(g.move(1, 40, 15))).toEqual(["drag"]);
    expect(kinds(g.up(1, 40, 15, 900))).toEqual(["dragEnd"]);
    g.down(1, 10, 10, 0, 0, can);
    expect(kinds(g.up(1, 11, 10, 100))).toEqual(["tap"]);
  });

  it("objet refusé : refused puis orbite", () => {
    const g = new Gesture();
    g.down(1, 0, 0, 0, 0, () => "refuse");
    expect(kinds(g.move(1, 10, 0))).toEqual(["refused", "orbit"]);
  });

  it("deux doigts : pan et pincer ensemble, jamais de tap ; bouton droit : pan", () => {
    const g = new Gesture();
    const can = vi.fn(() => "drag" as const);
    g.down(1, 0, 0, 0, 0, can);
    g.down(2, 100, 0, 0, 10, can);
    expect(can).toHaveBeenCalledTimes(1);
    const c = g.move(2, 120, 20);
    expect(kinds(c)).toEqual(["pan", "zoom"]);
    expect(c[0]).toMatchObject({ dx: 10, dy: 10 });
    expect((c[1] as { amount: number }).amount).toBeLessThan(0);
    expect(g.up(2, 120, 20, 50)).toEqual([]);
    expect(g.up(1, 0, 0, 60)).toEqual([]);
    g.down(1, 0, 0, 2, 0, () => null);
    expect(kinds(g.move(1, 10, 0))).toEqual(["pan"]);
  });

  it("geste repris par le navigateur pendant un glisser : dragCancel", () => {
    const g = new Gesture();
    g.down(1, 0, 0, 0, 0, () => "drag");
    g.move(1, 10, 0);
    expect(kinds(g.cancel(1))).toEqual(["dragCancel"]);
    expect(g.active).toBe(false);
  });
});

describe("sonic-procgen : édition au doigt (vue simulée)", () => {
  const recipe: Recipe = {
    size: [30, 30],
    ground: false,
    layers: [
      { id: "banc", gen: "seat.parkbench", place: { at: [[0, 0]] } },
      { id: "rochers", gen: "rock", count: 1, place: { grid: [1, 1], spacing: [3, 3], origin: [8, 8] } },
    ],
  };

  function setup(attrs: Record<string, string>) {
    const el = new SonicProcgen();
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    const m = composeScene({ recipe, seed: 1 });
    const under: { id: string | null } = { id: null };
    const view = Object.create(ProcgenView.prototype) as ProcgenView & Record<string, unknown>;
    Object.defineProperty(view, "cameraMode", { get: () => "perspective" });
    Object.assign(view, {
      pick: () => ({ objectId: under.id, generator: null, layer: null, x: 0, y: 0, z: 0, actor: null, zone: null }),
      select: vi.fn(() => null),
      dragBegin: vi.fn(() => true),
      groundPoint: (x: number, y: number) => [x / 10, y / 10],
      dragTo: vi.fn(),
      dragEnd: vi.fn(),
      interact: vi.fn(),
      getView: () => ({ cx: 0, cz: 0 }),
    });
    const host = el as unknown as Record<string, unknown>;
    host.view = view;
    host.model = m;
    host.mode = "3d";
    const events: { type: string; detail: Record<string, unknown> }[] = [];
    for (const t of ["select", "place", "dragstart", "dragRefused", "pick", "placeFree"]) el.addEventListener(`procgen-${t}`, (e) => events.push({ type: t, detail: (e as CustomEvent).detail }));
    const ptr = (kind: "onDown" | "onMove" | "onUp", id: number, x: number, y: number) => (host[kind] as (e: unknown) => void)({ pointerId: id, clientX: x, clientY: y, button: 0, shiftKey: false, pointerType: "touch" });
    return { el, view, under, events, ptr, m };
  }

  it("tap = select ; glisser l'objet sélectionné = une seule action place au lâcher, rotation inchangée", () => {
    const { view, under, events, ptr, m } = setup({ drag: ".*", "drag-selected": "" });
    const yaw0 = Math.round((m.objects.find((o) => o.id === "banc.0")!.yaw * 1800) / Math.PI) / 10;
    under.id = "banc.0";
    ptr("onDown", 1, 0, 0);
    ptr("onUp", 1, 1, 0);
    expect(events.filter((e) => e.type === "select")[0].detail).toMatchObject({ objectId: "banc.0", instance: "banc.0", layer: "banc", place: "at", index: 0, movable: true });
    events.length = 0;
    ptr("onDown", 1, 0, 0);
    ptr("onMove", 1, 20, 0);
    ptr("onMove", 1, 40, 30);
    expect(events.map((e) => e.type)).toEqual(["dragstart"]);
    ptr("onUp", 1, 40, 30);
    const place = events.filter((e) => e.type === "place");
    expect(place).toHaveLength(1);
    expect(place[0].detail).toMatchObject({ objectId: "banc.0", layer: "banc", index: 0, place: "at", valid: true, x: 4, z: 3 });
    expect(place[0].detail.yaw).toBe(yaw0);
    expect((view.dragEnd as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ x: 4, z: 3 });
  });

  it("drag-selected : un objet non sélectionné ne se glisse pas (orbite) ; calque semé : dragRefused", () => {
    const { el, view, under, events, ptr } = setup({ drag: ".*", "drag-selected": "" });
    under.id = "banc.0";
    ptr("onDown", 1, 0, 0);
    ptr("onMove", 1, 30, 0);
    ptr("onUp", 1, 30, 0);
    expect(events.some((e) => e.type === "place" || e.type === "dragstart")).toBe(false);
    expect((view.interact as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("rotate");
    under.id = "rochers.0";
    ptr("onDown", 1, 0, 0);
    ptr("onUp", 1, 0, 0);
    ptr("onDown", 1, 0, 0);
    ptr("onMove", 1, 30, 0);
    ptr("onUp", 1, 30, 0);
    expect(events.find((e) => e.type === "dragRefused")?.detail).toMatchObject({ objectId: "rochers.0", reason: "placement", place: "grid" });
    void el;
  });

  it("recomposition en cours : l'objet sélectionné se glisse quand même (pas d'orbite), le modèle arrivé pendant le geste est adopté au lâcher", () => {
    const { el, view, under, events, ptr } = setup({ drag: ".*", "drag-selected": "" });
    const host = el as unknown as Record<string, unknown>;
    under.id = "banc.0";
    ptr("onDown", 1, 0, 0);
    ptr("onUp", 1, 1, 0);
    host.composing = true;
    events.length = 0;
    const adopt = vi.fn();
    ptr("onDown", 1, 0, 0);
    ptr("onMove", 1, 20, 0);
    host.deferred = adopt;
    ptr("onMove", 1, 40, 30);
    expect(adopt).not.toHaveBeenCalled();
    ptr("onUp", 1, 40, 30);
    expect(events.map((e) => e.type)).toEqual(["dragstart", "place"]);
    expect(view.interact as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(host.deferred).toBe(null);
  });

  it("pose rejouée sur un modèle composé avant elle, oubliée par un modèle composé après", () => {
    const { el, view } = setup({});
    const host = el as unknown as { moved: Map<string, unknown>; replayMoves: (t: number) => void };
    host.moved.set("banc.0", { x: 5, y: 0, z: 6, yaw: 1, t: 10 });
    host.replayMoves(5);
    expect(view.dragBegin).toHaveBeenCalledWith("banc.0");
    expect((view.dragEnd as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ x: 5, z: 6, yaw: 1 });
    expect(host.moved.size).toBe(1);
    host.replayMoves(20);
    expect(host.moved.size).toBe(0);
    expect(view.dragEnd).toHaveBeenCalledTimes(1);
  });

  it("placeRequest : place libre publiée dans state-out.free et action placeFree", () => {
    const { el, events } = setup({});
    (el as unknown as { answerPlace: (r: unknown) => void }).answerPlace({ id: "n1", gen: "rock", at: [8, 8] });
    const f = events.find((e) => e.type === "placeFree")!.detail;
    expect(f).toMatchObject({ id: "n1", valid: true });
    expect(Math.hypot(Number(f.x) - 8, Number(f.z) - 8)).toBeGreaterThan(0.1);
    // l'objet déjà présent dans la recette ne se gêne pas lui-même
    (el as unknown as { answerPlace: (r: unknown) => void }).answerPlace({ id: "n2", gen: "rock", at: [8, 8], ignore: "rochers" });
    const g = events.filter((e) => e.type === "placeFree")[1].detail;
    expect([g.x, g.z]).toEqual([8, 8]);
  });
});
