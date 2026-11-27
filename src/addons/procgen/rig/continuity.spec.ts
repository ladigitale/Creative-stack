import { describe, expect, it } from "vitest";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { character } from "../gen/character";
import { ACTIONS, type MotionState, humanoidPose, rigInfo } from "./locomotion";
import { PoseBlend } from "./motion";

/**
 * Raccords des gestes : rendu image par image (60 i/s) à travers le mélangeur de poses, aucune articulation ne doit
 * « téléporter » — ni aux bouclages des cycles, ni aux changements de figure (danse), ni quand un bras passe près
 * d'un demi-tour ou au-dessus de la tête. Un saut est une image bien plus rapide que celles qui la précèdent (plus de 6
 * hauteurs de corps par seconde et plus de 3,5 fois la plus rapide des deux images d'avant) : une frappe accélère sur
 * plusieurs images (et peut s'arrêter net à l'impact), un saut part de rien. Avant correction : danse 42 H/s pour 0,4 autour, arc 29, coup de pied 24.
 */
describe("gestes sans à-coup", () => {
  it("toutes les actions, 12 s chacune, 3 styles", { timeout: 120000 }, () => {
    const J = ["hand.l", "hand.r", "forearm.l", "forearm.r", "head", "shin.l", "shin.r", "foot.l", "foot.r"];
    const bad: string[] = [];
    for (const archetype of ["stylized", "chibi", "realistic"]) {
      const p = resolveParams(character.schema, { archetype, detail: "crowd", item: "none" }, { rng: new Rng("c"), vars: {} }, new Issues());
      const a = character.build(p as never, { rng: new Rng("c"), issues: new Issues(), path: "" });
      const sk = a.skeleton!, info = rigInfo(sk);
      const H = a.height;
      for (const action of ACTIONS) {
        if (action === "walk" || action === "run") continue;
        const blend = new PoseBlend();
        let prev: number[][] | null = null;
        const sp: number[] = [];
        for (let i = 0; i < 720; i++) {
          const t = i / 60;
          const st: MotionState = { speed: 0, phase: 0, time: t, action, actionTime: t, actionWeight: 1, mood: "neutral", turn: 0, seed: 3 };
          const W = sk.world(blend.apply(humanoidPose(sk, info, st).pose, action, 1 / 60));
          const cur = J.map((j) => sk.tailOf(W, j) as number[]);
          if (prev) {
            let v = 0;
            for (let k = 0; k < J.length; k++) v = Math.max(v, (Math.hypot(cur[k][0] - prev[k][0], cur[k][1] - prev[k][1], cur[k][2] - prev[k][2]) * 60) / H);
            sp.push(v);
          }
          prev = cur;
        }
        for (let i = 2; i < sp.length; i++) {
          const before = Math.max(sp[i - 1], sp[i - 2]);
          if (sp[i] > 6 && sp[i] > 3.5 * before) {
            bad.push(`${archetype}/${action} ${sp[i].toFixed(1)} H/s (avant ${before.toFixed(1)}) à ${((i + 1) / 60).toFixed(2)} s`);
            break;
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
