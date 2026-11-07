import { describe, expect, it } from "vitest";
import { PuppetRig, assignOwners, capRadius, extractParts, measureArmature, measureBones, type Joints, type MeasuredBone } from "./puppet";
import { dir } from "./skeleton";

const W = 200;
const H = 300;

/** Joints d'un corps de face, bras le long du corps (coordonnées normalisées). */
function body(over: Joints = {}): Joints {
  const j = (x: number, y: number, v = 1) => ({ x: x / W, y: y / H, v });
  return {
    nose: j(100, 40),
    leftEar: j(88, 38),
    rightEar: j(112, 38),
    leftShoulder: j(70, 90),
    rightShoulder: j(130, 90),
    leftElbow: j(60, 140),
    rightElbow: j(140, 140),
    leftWrist: j(58, 185),
    rightWrist: j(142, 185),
    leftIndex: j(56, 200),
    rightIndex: j(144, 200),
    leftPinky: j(60, 198),
    rightPinky: j(140, 198),
    leftHip: j(85, 170),
    rightHip: j(115, 170),
    leftKnee: j(83, 225),
    rightKnee: j(117, 225),
    leftAnkle: j(82, 275),
    rightAnkle: j(118, 275),
    leftFootIndex: j(78, 292),
    rightFootIndex: j(122, 292),
    ...over,
  };
}

/** Silhouette synthétique opaque : tronc, tête, bras, jambes (rectangles et disque). */
function silhouette(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  const rect = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        d[i] = c[0];
        d[i + 1] = c[1];
        d[i + 2] = c[2];
        d[i + 3] = 255;
      }
    }
  };
  rect(72, 85, 128, 172, [200, 40, 40]); // tronc
  rect(86, 20, 114, 60, [230, 190, 150]); // tête (boîte)
  rect(55, 88, 72, 190, [40, 40, 200]); // bras gauche
  rect(128, 88, 145, 190, [40, 200, 40]); // bras droit
  rect(78, 170, 98, 295, [60, 60, 60]); // jambe gauche
  rect(102, 170, 122, 295, [90, 90, 90]); // jambe droite
  return d;
}

describe("measureBones", () => {
  it("un os par segment mesuré, parents avant enfants, racine sans image", () => {
    const m = measureBones(body(), W, H)!;
    expect(m).not.toBeNull();
    const names = m.bones.map((b) => b.name);
    expect(names[0]).toBe("bassin");
    expect(m.bones[0].sprite).toBe(false);
    for (const n of ["torse", "tete", "bras-gauche", "avant-bras-gauche", "main-gauche", "bras-droit", "main-droite", "cuisse-gauche", "mollet-gauche", "pied-gauche", "cuisse-droite"]) {
      expect(names).toContain(n);
    }
    expect(m.missing).toEqual([]);
    expect(m.body).toBeCloseTo(60, 5);
    const idx = new Map(names.map((n, i) => [n, i]));
    for (const b of m.bones) if (b.parent) expect(idx.get(b.parent)!).toBeLessThan(idx.get(b.name)!);
  });

  it("l'os prend la position réelle des articulations (aucune proportion préréglée)", () => {
    const m = measureBones(body(), W, H)!;
    const arm = m.bones.find((b) => b.name === "bras-gauche")!;
    expect(arm.start).toEqual({ x: 70, y: 90 });
    expect(arm.end).toEqual({ x: 60, y: 140 });
    const torso = m.bones.find((b) => b.name === "torse")!;
    expect(torso.start).toEqual({ x: 100, y: 170 }); // milieu des hanches
    expect(torso.end).toEqual({ x: 100, y: 90 }); // milieu des épaules
  });

  it("photo en buste : bassin virtuel sous les épaules, jambes absentes", () => {
    const bust = body({
      leftHip: { x: 0.4, y: 1.2, v: 0.9 },
      rightHip: { x: 0.6, y: 1.2, v: 0.9 },
      leftKnee: { x: 0.4, y: 1.5, v: 0.1 },
      rightKnee: { x: 0.6, y: 1.5, v: 0.1 },
    });
    const m = measureBones(bust, W, H)!;
    const torso = m.bones.find((b) => b.name === "torse")!;
    expect(torso.start.x).toBeCloseTo(100, 5);
    expect(torso.start.y).toBeCloseTo(90 + 1.35 * 60, 5);
    const names = m.bones.map((b) => b.name);
    expect(names).not.toContain("cuisse-gauche");
    expect(m.missing).toContain("cuisse-gauche");
    expect(names).toContain("bras-gauche");
  });

  it("os peu visible ou hors cadre : absent ; sans épaules : null", () => {
    const m = measureBones(body({ leftElbow: { x: 0.3, y: 0.46, v: 0.2 } }), W, H)!;
    const names = m.bones.map((b) => b.name);
    expect(names).not.toContain("bras-gauche");
    expect(names).not.toContain("avant-bras-gauche");
    expect(names).toContain("bras-droit");
    expect(measureBones(body({ leftShoulder: undefined }), W, H)).toBeNull();
    expect(measureBones(body({ rightShoulder: { x: 0.65, y: 0.3, v: 0.1 } }), W, H)).toBeNull();
  });
});

describe("assignOwners / extractParts", () => {
  const m = measureBones(body(), W, H)!;
  const img = silhouette();
  const owners = assignOwners(img, W, H, m.bones);
  const ownerAt = (x: number, y: number) => m.bones[owners[y * W + x]]?.name;

  it("chaque région va à l'os qui la couvre ; le fond n'appartient à personne", () => {
    expect(ownerAt(100, 130)).toBe("torse");
    expect(ownerAt(63, 115)).toBe("bras-gauche");
    expect(ownerAt(135, 165)).toBe("avant-bras-droit");
    expect(ownerAt(100, 30)).toBe("tete");
    expect(ownerAt(88, 250)).toBe("mollet-gauche");
    expect(ownerAt(5, 5)).toBeUndefined();
    expect(owners[5 * W + 5]).toBe(-1);
  });

  it("la silhouette est entièrement couverte par les pièces, avec recouvrement aux jonctions", () => {
    const parts = extractParts(img, W, H, m.bones, owners);
    const cover = new Uint8Array(W * H);
    for (const p of parts) {
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) if (p.data[(y * p.w + x) * 4 + 3] > 0) cover[(p.y + y) * W + (p.x + x)]++;
      }
    }
    let holes = 0;
    let doubled = 0;
    for (let i = 0; i < W * H; i++) {
      if (img[i * 4 + 3] > 0 && cover[i] === 0) holes++;
      if (cover[i] > 1) doubled++;
    }
    expect(holes).toBe(0);
    expect(doubled).toBeGreaterThan(0);
    // aucune pièce ne déborde de la silhouette
    for (const p of parts) {
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          if (p.data[(y * p.w + x) * 4 + 3] > 0) expect(img[((p.y + y) * W + (p.x + x)) * 4 + 3]).toBeGreaterThan(0);
        }
      }
    }
  });

  it("le recouvrement tient dans le rayon de l'articulation de l'enfant", () => {
    const parts = extractParts(img, W, H, m.bones, owners);
    const arm = parts.find((p) => p.name === "bras-gauche")!;
    const bone = m.bones.find((b) => b.name === "bras-gauche")!;
    const r = capRadius(bone);
    // pixel du tronc dans le bras : dans le rayon autour de l'épaule seulement
    for (let y = 0; y < arm.h; y++) {
      for (let x = 0; x < arm.w; x++) {
        if (arm.data[(y * arm.w + x) * 4 + 3] === 0) continue;
        const gx = arm.x + x;
        const gy = arm.y + y;
        if (ownerAt(gx, gy) === "torse") expect(Math.hypot(gx - bone.start.x, gy - bone.start.y)).toBeLessThanOrEqual(r + 1e-6);
      }
    }
  });

  it("le pivot d'une pièce est l'articulation de son os, dans sa boîte", () => {
    const parts = extractParts(img, W, H, m.bones, owners);
    for (const p of parts) {
      const b = m.bones.find((bb) => bb.name === p.name)!;
      expect(p.x + p.pivot.x).toBeCloseTo(b.start.x, 5);
      expect(p.y + p.pivot.y).toBeCloseTo(b.start.y, 5);
    }
  });
});

describe("PuppetRig", () => {
  const m = measureBones(body(), W, H)!;
  const bone = (n: string): MeasuredBone => m.bones.find((b) => b.name === n)!;

  it("au repos, chaque nœud est sur son articulation mesurée et rz vaut 0", () => {
    const out = new PuppetRig(m.bones).solve();
    for (const b of m.bones) {
      expect(out[b.name].x).toBeCloseTo(b.start.x, 4);
      expect(out[b.name].y).toBeCloseTo(b.start.y, 4);
      expect(out[b.name].rz).toBeCloseTo(0, 6);
    }
  });

  it("un os qui tourne entraîne ses enfants autour de son articulation", () => {
    const rig = new PuppetRig(m.bones);
    const turn = Math.PI / 2; // +90° : sens horaire à l'écran
    const out = rig.solve({ "bras-gauche": turn });
    const arm = bone("bras-gauche");
    const elbow = bone("avant-bras-gauche").start;
    // le coude (début de l'avant-bras) a pivoté de 90° autour de l'épaule : même distance, nouvelle direction
    const dist = Math.hypot(elbow.x - arm.start.x, elbow.y - arm.start.y);
    expect(Math.hypot(out["avant-bras-gauche"].x - arm.start.x, out["avant-bras-gauche"].y - arm.start.y)).toBeCloseTo(dist, 4);
    const restDir = Math.atan2(elbow.y - arm.start.y, elbow.x - arm.start.x);
    const newDir = Math.atan2(out["avant-bras-gauche"].y - arm.start.y, out["avant-bras-gauche"].x - arm.start.x);
    let d = newDir - restDir;
    while (d < -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    // sens horaire à l'écran (y vers le bas) = angle croissant d'atan2
    expect(d).toBeCloseTo(turn, 4);
    expect(out["bras-gauche"].rz).toBeCloseTo(turn, 4);
    expect(out["avant-bras-gauche"].rz).toBeCloseTo(turn, 4); // hérite de la rotation du parent
    expect(out["main-gauche"].rz).toBeCloseTo(turn, 4);
    // l'épaule ne bouge pas, ni l'autre bras
    expect(out["bras-gauche"].x).toBeCloseTo(arm.start.x, 4);
    expect(out["bras-droit"].rz).toBeCloseTo(0, 6);
  });

  it("l'extrémité de l'os suit la direction de repos tournée", () => {
    const rig = new PuppetRig(m.bones);
    const out = rig.solve({ "cuisse-gauche": 0.4 });
    // le genou (début du mollet) est à longueur constante de la hanche, dans la direction tournée
    const th = bone("cuisse-gauche");
    const len = Math.hypot(th.end.x - th.start.x, th.end.y - th.start.y);
    const rest = Math.atan2(th.end.y - th.start.y, th.end.x - th.start.x);
    const knee = out["mollet-gauche"];
    expect(Math.hypot(knee.x - th.start.x, knee.y - th.start.y)).toBeCloseTo(len, 3);
    expect(Math.atan2(knee.y - th.start.y, knee.x - th.start.x)).toBeCloseTo(rest + 0.4, 3);
    void dir;
  });

  it("décalage de la racine : tout le corps suit", () => {
    const out = new PuppetRig(m.bones).solve({}, { x: 10, y: -4 });
    expect(out["torse"].x).toBeCloseTo(bone("torse").start.x + 10, 4);
    expect(out["bras-droit"].y).toBeCloseTo(bone("bras-droit").start.y - 4, 4);
    expect(out["bras-droit"].rz).toBeCloseTo(0, 6);
  });
});

describe("measureArmature", () => {
  const J: Joints = { a: { x: 0.2, y: 0.2, v: 1 }, b: { x: 0.2, y: 0.5, v: 1 }, c: { x: 0.2, y: 0.8, v: 0.1 }, d: { x: 0.6, y: 0.2, v: 1 } };
  const spec = [
    { name: "racine", from: "a", sprite: false },
    { name: "haut", parent: "racine", from: "a", to: "b", radius: 0.1, z: 1 },
    { name: "bas", parent: "haut", cap: "haut", from: "b", to: "c", radius: 0.1, z: 2 },
    { name: "suite", parent: "bas", from: "c", to: "d" },
  ];
  it("mesure les segments entre points nommés ; un point peu visible retire l'os et ses descendants", () => {
    const m = measureArmature(spec, J, W, H, { unit: ["a", "d"] })!;
    expect(m.bones.map((b) => b.name)).toEqual(["racine", "haut"]);
    expect(m.missing).toEqual(["bas", "suite"]);
    expect(m.body).toBeCloseTo(0.4 * W, 5);
    expect(m.bones[1].radius).toBeCloseTo(Math.max(6, 0.1 * 0.4 * W), 5);
  });
  it("`to` en paire = milieu ; `extend` prolonge ; unité en pixels ; sans unité mesurable : null", () => {
    const m = measureArmature([{ name: "o", from: "a", to: ["b", "d"], extend: 2, radius: 0.2 }], J, W, H, { unit: 100 })!;
    const b = m.bones[0];
    expect(b.end.x).toBeCloseTo(0.2 * W + (0.4 * W - 0.2 * W) * 2, 5);
    expect(measureArmature(spec, J, W, H, { unit: ["a", "zzz"] })).toBeNull();
  });
});

