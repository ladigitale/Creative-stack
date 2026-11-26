import { describe, expect, it } from "vitest";
import { Rng } from "../../core/rng";
import { Issues, resolveParams } from "../../core/schema";
import { Field } from "../../geom/implicit";
import { character } from "../character";
import { buildBodyField, corePoints } from "./body";
import { characterKit } from "./build";
import { resolveLook } from "./look";

/** Corps et accessoires d'un personnage tiré au hasard (mêmes tirages que `character.build`). */
function bodyOf(params: Record<string, unknown>, seed: string) {
  const issues = new Issues();
  const rng = new Rng(seed);
  const p = resolveParams(character.schema, params, { rng, vars: {} }, issues) as unknown as Parameters<typeof resolveLook>[0];
  const look = resolveLook(p, rng, issues, "t");
  const { k, H, thick } = characterKit(look, rng.fork("var"));
  const bf = buildBodyField(k);
  const skip = new Set(["upperarm", "forearm", "hand", "bag", "belt", "tail"]);
  const armBone = (i: number) => /arm|hand|clavicle/.test(k.skel.bones[bf.set.bone[i]]?.name ?? "");
  const body = new Field(bf.set.prims.filter((_, i) => !skip.has(bf.set.group[i]) && !armBone(i)));
  return { bf, body, H, thick, look };
}

describe("accessoires : jamais dans le corps", () => {
  const BAGS = ["backpack", "satchel", "pouch", "scarf", "cape"];
  const BELTS = ["belt", "sash"];
  const TOPS = ["shirt", "coat", "robe", "tunic", "dress"];
  const OVERS = ["none", "vest", "jacket", "armor"];
  const ARCH = ["realistic", "stylized", "cartoon", "chibi", "heroic"];

  it("sacs, sangles, nœuds et ceintures restent hors de la silhouette habillée (120 tirages)", () => {
    const bad: string[] = [];
    for (let i = 0; i < 120; i++) {
      const params = { bag: BAGS[i % 5], belt: BELTS[i % 2], top: TOPS[(i >> 1) % 5], over: OVERS[(i >> 2) % 4], archetype: ARCH[(i >> 3) % 5], build: "auto", belly: "auto" };
      const { bf, body, H, thick } = bodyOf(params, `acc-${i}`);
      bf.set.prims.forEach((f, j) => {
        const g = bf.set.group[j];
        if (g !== "bag" && g !== "belt") return;
        // anneau centré (ceinture, col) : son pourtour à 97 % ne doit pas être enfoui dans le vêtement
        if (f.kind === "ellipsoid" && Math.hypot(f.c[0], 0) < H * 0.02 && f.r[0] > H * 0.05) {
          for (let a = 0; a < 16; a++) {
            const t = (a / 16) * Math.PI * 2;
            const p: [number, number, number] = [f.c[0] + Math.sin(t) * f.r[0] * 0.97, f.c[1], f.c[2] + Math.cos(t) * f.r[2] * 0.97];
            const d = body.eval(p).d;
            if (d < -thick * 1.5) bad.push(`${i} ${JSON.stringify(params)} anneau ${g} enfoui de ${(-d / H).toFixed(4)}H`);
          }
          return;
        }
        const tol = f.kind === "capsule" ? Math.max(f.ra, f.rb) * 0.5 : H * 0.004;
        for (const p of corePoints(f)) {
          const d = body.eval(p).d;
          if (d < -tol) {
            bad.push(`${i} ${JSON.stringify(params)} ${g}/${f.kind} enfoui de ${(-d / H).toFixed(4)}H`);
            break;
          }
        }
      });
    }
    expect(bad.slice(0, 12)).toEqual([]);
  });
});
