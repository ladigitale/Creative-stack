import { readFileSync } from "node:fs";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
// @ts-ignore module JS sans types (générateur)
import { MODELS, envelope } from "../addons/3d/library/generate.mjs";
import lib3d from "../addons/3d/library/library.json";
import lib2d from "../addons/2d/library/library.json";
import libSound from "../addons/sound/library/library.json";

const read = (addon: string, file: string) => readFileSync(`src/addons/${addon}/library/${file}`, "utf8");

describe("ressources de base 3D", () => {
  it("les fichiers commités sont ceux que produit le générateur", () => {
    for (const e of lib3d.entries) {
      expect(read("3d", e.file), e.id).toBe(envelope((MODELS as Record<string, () => unknown>)[e.id]));
    }
  });

  it("GLB valide (en-tête, longueurs, accesseurs) et noeuds annoncés présents", async () => {
    for (const e of lib3d.entries) {
      const env = JSON.parse(read("3d", e.file)) as { format: string; glb: string; bytes: number; nodes: string[] };
      expect(env.format).toBe("glb-base64");
      // 64 Ko max par fichier d'artefact (`files`) : le base64 doit y tenir.
      expect(env.glb.length, e.id).toBeLessThan(64 * 1024);
      const buf = Buffer.from(env.glb, "base64");
      expect(buf.length).toBe(env.bytes);
      expect(buf.toString("ascii", 0, 4)).toBe("glTF");
      expect(buf.readUInt32LE(8)).toBe(buf.length);
      const jsonLen = buf.readUInt32LE(12);
      const gltf = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
      const binLen = buf.readUInt32LE(20 + jsonLen);
      expect(gltf.buffers[0].byteLength).toBeLessThanOrEqual(binLen);
      for (const a of gltf.accessors) {
        const v = gltf.bufferViews[a.bufferView];
        const size = { 5126: 4, 5123: 2 }[a.componentType as 5126 | 5123] * { VEC3: 3, SCALAR: 1 }[a.type as "VEC3" | "SCALAR"];
        expect(v.byteOffset + a.count * size, e.id).toBeLessThanOrEqual(v.byteOffset + v.byteLength);
        expect(v.byteOffset % 4).toBe(0);
      }
      // ArrayBuffer créé dans le realm du test (celui de jsdom), pas celui de Buffer.
      const ab = new ArrayBuffer(buf.length);
      new Uint8Array(ab).set(buf);
      const parsed = await new Promise<{ scene: { getObjectByName(n: string): unknown } }>((res, rej) =>
        new GLTFLoader().parse(ab, "", res as never, rej),
      );
      for (const name of env.nodes) expect(parsed.scene.getObjectByName(name), `${e.id}:${name}`).toBeTruthy();
    }
  });

  it("le plateau expose bien 25 cases cell_<ligne>_<colonne>", () => {
    const env = JSON.parse(read("3d", "plateau-grille-5x5.json")) as { nodes: string[] };
    expect(env.nodes.filter((n) => /^cell_[0-4]_[0-4]$/.test(n))).toHaveLength(25);
  });
});

describe("ressources de base données et images", () => {
  it("jeu de 52 cartes : ids uniques, 13 rangs × 4 couleurs", () => {
    const d = JSON.parse(read("2d", "jeu-de-cartes-52.json")) as { cartes: { id: string; couleur: string; valeur: number }[] };
    expect(d.cartes).toHaveLength(52);
    expect(new Set(d.cartes.map((c) => c.id)).size).toBe(52);
    for (const s of ["coeur", "carreau", "trefle", "pique"]) {
      expect(d.cartes.filter((c) => c.couleur === s).map((c) => c.valeur)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    }
  });

  it("palettes : cinq couleurs hex valides", () => {
    const d = JSON.parse(read("2d", "palettes-couleurs.json")) as { palettes: { id: string; couleurs: string[] }[] };
    for (const p of d.palettes) {
      expect(p.couleurs, p.id).toHaveLength(5);
      for (const c of p.couleurs) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("gammes : intervalles croissants, accords commençant à 0", () => {
    const d = JSON.parse(read("sound", "gammes-accords.json")) as { gammes: Record<string, number[]>; accords: Record<string, number[]> };
    for (const [n, g] of Object.entries(d.gammes)) {
      expect(g[0], n).toBe(0);
      expect(g.every((v, i) => i === 0 || v > g[i - 1]) && g.at(-1)! < 12, n).toBe(true);
    }
    for (const [n, c] of Object.entries(d.accords)) {
      expect(c[0], n).toBe(0);
      expect(c.every((v, i) => i === 0 || v > c[i - 1]), n).toBe(true);
    }
  });

  it("SVG : sans script, gestionnaire d'événement ni ressource externe", () => {
    for (const e of lib2d.entries.filter((x) => x.kind === "image")) {
      const svg = read("2d", e.file);
      expect(svg, e.id).toMatch(/^<svg\b/);
      expect(svg).not.toMatch(/<script|\son\w+\s*=|href\s*=|<image|<foreignObject|@import|url\(\s*["']?https?:/i);
    }
  });

  it("chaque entrée a licence, version et tags (index consolidé)", () => {
    for (const e of [...lib3d.entries, ...lib2d.entries, ...libSound.entries]) {
      expect(e.license).toBe("MIT");
      expect(e.version).toBe(1);
      expect(e.tags.length).toBeGreaterThan(0);
    }
  });
});
