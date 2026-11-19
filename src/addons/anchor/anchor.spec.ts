import { describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
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

describe("sonic-anchor-ref", () => {
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
});
