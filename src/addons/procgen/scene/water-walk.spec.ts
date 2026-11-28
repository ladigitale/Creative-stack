import { describe, expect, it } from "vitest";
import { NavGrid } from "./nav";
import { composeScene, groundHeight } from "./compose";
import { SCENES } from "./library";
import { inSwimwear, swimwear } from "../gen/character/look";
import type { Look } from "../gen/character/look";
import { buildCharacterFromKey } from "../gen/character";
import { humanoidPose, rigInfo } from "../rig/locomotion";
import type { Skeleton } from "../rig/skeleton";

describe("eau : jamais de marcheur habillé dedans", () => {
  it("une destination dans une case bloquée (eau, mur) mène au bord libre le plus proche", () => {
    const g = new NavGrid(10, 10, 0.5);
    g.blockBox(3, 0, 2, 5, 0, 0);
    const p = g.path([-3, 0], [3, 0])!;
    const end = p[p.length - 1];
    expect(g.free(end[0], end[1])).toBe(true);
    expect(end[0]).toBeLessThan(1.1);
    // destination libre : gardée telle quelle
    expect(g.path([-3, 0], [-1, 2])!.at(-1)).toEqual([-1, 2]);
  });

  it("au bord de mer, les promeneurs ne trouvent aucun chemin qui finisse dans l'eau", () => {
    const m = composeScene({ recipe: SCENES["bord-de-mer"], seed: 1 });
    const nav = m.nav!;
    const wl = m.terrain!.spec.water!;
    for (let k = 0; k < 40; k++) {
      const to: [number, number] = [-30 + k * 1.5, 18];
      const p = nav.path([-4, 3], to);
      if (!p) continue;
      const e = p[p.length - 1];
      // sol ou tablier (ponton) : jamais au fond de l'eau
      expect(groundHeight(m, e[0], e[1], wl)).toBeGreaterThan(wl - 0.15);
    }
  });
});

describe("tenue de bain", () => {
  const look = (): Look => {
    const m = composeScene({ recipe: { size: [4, 4], actors: { a: { params: { archetype: "stylized", figure: "feminine", top: "coat", bottom: "trousers", hat: "tophat", item: "lantern", age: "adult" }, at: [0, 0] } } }, seed: 2 });
    return (m.actors[0].asset.extra as { look: Look }).look;
  };
  it("maillot, pieds nus, ni chapeau ni objet ; torse nu pour une silhouette masculine", () => {
    const l = look();
    expect(inSwimwear(l)).toBe(false);
    const sw = swimwear(l);
    expect(sw).toMatchObject({ top: "swimsuit", bottom: "swim", shoes: "barefoot", hat: "none", item: "none", over: "none" });
    expect(inSwimwear(sw)).toBe(true);
    expect(swimwear({ ...l, figure: "masculine" }).top).toBe("none");
    // même corps : mêmes cheveux, même visage, même taille
    expect(sw.hair).toBe(l.hair);
    expect(sw.height).toBe(l.height);
  });
  it("même squelette et mêmes canaux de visage que la tenue d'origine (échange de maillage possible)", () => {
    const m = composeScene({ recipe: { size: [4, 4], actors: { a: { params: { archetype: "stylized", top: "sweater", bottom: "trousers", age: "adult" }, at: [0, 0] } } }, seed: 3 });
    const a = m.actors[0].asset;
    const ex = a.extra as { look: Look; vkey: string };
    const b = buildCharacterFromKey(swimwear(ex.look), ex.vkey);
    expect(b.skeleton.count).toBe(a.skeleton!.count);
    expect(b.expr?.channels).toEqual(a.expr?.channels);
    expect(Math.abs(b.height - a.height)).toBeLessThan(0.08);
  });
  it("demandé en paramètres : rien par-dessus le maillot, pieds nus", () => {
    const m = composeScene({ recipe: { size: [4, 4], actors: { a: { params: { top: "swimsuit", bottom: "swim" }, at: [0, 0] } } }, seed: 4 });
    const l = (m.actors[0].asset.extra as { look: Look }).look;
    expect(l).toMatchObject({ over: "none", belt: "none", gloves: "none", shoes: "barefoot", bag: "none", item: "none" });
  });
});

describe("plongée (apnée)", () => {
  it("corps couché tête vers le fond en descendant, relevé en remontant", () => {
    const m = composeScene({ recipe: { size: [4, 4], actors: { a: { params: { archetype: "stylized", age: "adult" }, at: [0, 0] } } }, seed: 5 });
    const sk = m.actors[0].asset.skeleton as unknown as Skeleton;
    const info = rigInfo(sk);
    const pitch = (tilt: number) => {
      const { pose } = humanoidPose(sk, info, { speed: 0.8, phase: 0, time: 2, action: "dive", actionTime: 1, actionWeight: 1, mood: "neutral", turn: 0, seed: 3, diveTilt: tilt }, [0, 0, 0], 0);
      const W = sk.world(pose);
      const head = W[sk.index.head], pel = W[sk.index.pelvis];
      return head[13] - pel[13];
    };
    // tête plus basse que le bassin en descendant, plus haute en remontant, à peu près au niveau à plat
    expect(pitch(0.5)).toBeLessThan(pitch(0));
    expect(pitch(-0.5)).toBeGreaterThan(pitch(0));
    expect(Math.abs(pitch(0))).toBeLessThan(0.35);
  });
});
