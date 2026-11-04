/**
 * Génère les modèles 3D de base (`*.json`, enveloppe {format:"glb-base64", glb, nodes}) à partir de
 * primitives simples. Déterministe : `yarn library:3d` ne change rien si rien n'a changé
 * (le spec 3d-library.spec.ts compare le résultat à ce qui est commité).
 *
 * Pas de dépendance : écrit directement le glTF binaire (positions, normales, indices uint16).
 * Original, sans asset tiers.
 */
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Boîte centrée sur l'origine : 24 sommets (normales par face), 36 indices. */
export function box(w, h, d) {
  const x = w / 2, y = h / 2, z = d / 2;
  const faces = [
    [[1, 0, 0], [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]]],
    [[-1, 0, 0], [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]]],
    [[0, 1, 0], [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]]],
    [[0, -1, 0], [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]]],
    [[0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]],
    [[0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]]],
  ];
  const positions = [], normals = [], indices = [];
  faces.forEach(([n, quad], f) => {
    for (const p of quad) { positions.push(...p); normals.push(...n); }
    const o = f * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { positions, normals, indices };
}

/** Cylindre d'axe y, centré, `seg` côtés : flancs lisses + deux disques. */
export function cylinder(r, h, seg = 24) {
  const positions = [], normals = [], indices = [];
  const y = h / 2;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    positions.push(c * r, -y, s * r, c * r, y, s * r);
    normals.push(c, 0, s, c, 0, s);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  for (const [ny, yy, flip] of [[1, y, false], [-1, -y, true]]) {
    const center = positions.length / 3;
    positions.push(0, yy, 0); normals.push(0, ny, 0);
    const ring = positions.length / 3;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      positions.push(Math.cos(a) * r, yy, Math.sin(a) * r); normals.push(0, ny, 0);
    }
    for (let i = 0; i < seg; i++) {
      const p = ring + i, q = ring + ((i + 1) % seg);
      indices.push(center, flip ? p : q, flip ? q : p);
    }
  }
  return { positions, normals, indices };
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * Description : geos {id: geo}, materials {id: {name, color:[r,g,b,a], metallic, roughness}},
 * meshes [{id, geo, material}], nodes [{name, mesh?, translation?, children?}] (le premier est la racine).
 */
export function buildGlb({ geos, materials, meshes, nodes }) {
  const chunks = [];
  let offset = 0;
  const bufferViews = [], accessors = [];
  const push = (bytes, target) => {
    const pad = (4 - (bytes.byteLength % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), Buffer.alloc(pad));
    offset += bytes.byteLength + pad;
    return bufferViews.length - 1;
  };
  const geoAcc = {};
  for (const [id, g] of Object.entries(geos)) {
    const pos = new Float32Array(g.positions.map(r6)), nor = new Float32Array(g.normals.map(r6)), idx = new Uint16Array(g.indices);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); }
    const a = accessors.length;
    accessors.push({ bufferView: push(pos, 34962), componentType: 5126, count: pos.length / 3, type: "VEC3", min: mn, max: mx });
    accessors.push({ bufferView: push(nor, 34962), componentType: 5126, count: nor.length / 3, type: "VEC3" });
    accessors.push({ bufferView: push(idx, 34963), componentType: 5123, count: idx.length, type: "SCALAR" });
    geoAcc[id] = a;
  }
  const matIds = Object.keys(materials);
  const gltf = {
    asset: { version: "2.0", generator: "creative-stack/3d/library/generate.mjs" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    materials: matIds.map((id) => {
      const m = materials[id];
      return { name: m.name, pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: m.metallic ?? 0, roughnessFactor: m.roughness ?? 0.8 } };
    }),
    meshes: meshes.map((m) => ({ name: m.id, primitives: [{ attributes: { POSITION: geoAcc[m.geo], NORMAL: geoAcc[m.geo] + 1 }, indices: geoAcc[m.geo] + 2, material: matIds.indexOf(m.material) }] })),
    nodes: nodes.map((n) => {
      const o = { name: n.name };
      if (n.mesh) o.mesh = meshes.findIndex((m) => m.id === n.mesh);
      if (n.translation) o.translation = n.translation.map(r6);
      if (n.children) o.children = n.children;
      return o;
    }),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let json = Buffer.from(JSON.stringify(gltf), "utf8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const total = 12 + 8 + json.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii"); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.write("JSON", 4, "ascii");
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write("BIN\0", 4, "latin1");
  return Buffer.concat([head, jh, json, bh, bin]);
}

const rgba = (hex, a = 1) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, a].map(r6);

/** Plateau 5×5 : cadre en bois procédural (tex:wood) et cases `cell_<ligne>_<colonne>` en damier. */
function plateau() {
  const N = 5, step = 1.05;
  const nodes = [{ name: "plateau", children: [] }];
  const add = (n) => { nodes.push(n); nodes[0].children.push(nodes.length - 1); };
  add({ name: "cadre", mesh: "cadre", translation: [0, 0, 0] });
  const off = ((N - 1) * step) / 2;
  const names = ["plateau", "cadre"];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const name = `cell_${r}_${c}`;
    names.push(name);
    add({ name, mesh: (r + c) % 2 ? "case_sombre" : "case_claire", translation: [c * step - off, 0.15, r * step - off] });
  }
  const glb = buildGlb({
    geos: { cadre: box(N * step + 0.5, 0.2, N * step + 0.5), case: box(1, 0.1, 1) },
    materials: {
      bois: { name: "tex:wood", color: rgba("#8a5a2b"), roughness: 0.7 },
      claire: { name: "case_claire", color: rgba("#e8dcc2"), roughness: 0.9 },
      sombre: { name: "case_sombre", color: rgba("#5c6b73"), roughness: 0.9 },
    },
    meshes: [
      { id: "cadre", geo: "cadre", material: "bois" },
      { id: "case_claire", geo: "case", material: "claire" },
      { id: "case_sombre", geo: "case", material: "sombre" },
    ],
    nodes,
  });
  return { glb, nodes: names };
}

/** Six pions cylindriques `pion_0`…`pion_5` alignés sur x, une couleur chacun. */
function pions() {
  const colors = ["#e63946", "#f4a261", "#e9c46a", "#2a9d8f", "#457b9d", "#8d5fd3"];
  const meshes = colors.map((_, i) => ({ id: `pion_${i}`, geo: "pion", material: `c${i}` }));
  const materials = Object.fromEntries(colors.map((c, i) => [`c${i}`, { name: `pion_${i}`, color: rgba(c), roughness: 0.45 }]));
  const nodes = [{ name: "pions", children: colors.map((_, i) => i + 1) }];
  colors.forEach((_, i) => nodes.push({ name: `pion_${i}`, mesh: `pion_${i}`, translation: [(i - 2.5) * 0.9, 0.3, 0] }));
  return { glb: buildGlb({ geos: { pion: cylinder(0.32, 0.6, 28) }, materials, meshes, nodes }), nodes: ["pions", ...colors.map((_, i) => `pion_${i}`)] };
}

/** Socle de vitrine : disque épais + anneau fin, pour présenter un objet posé en y = 0.4. */
function socle() {
  const nodes = [{ name: "socle_vitrine", children: [1, 2] }, { name: "socle", mesh: "socle", translation: [0, 0.15, 0] }, { name: "anneau", mesh: "anneau", translation: [0, 0.33, 0] }];
  return {
    glb: buildGlb({
      geos: { socle: cylinder(1.4, 0.3, 48), anneau: cylinder(1.15, 0.06, 48) },
      materials: { base: { name: "socle", color: rgba("#2b2d42"), metallic: 0.2, roughness: 0.5 }, or: { name: "anneau", color: rgba("#d4af37"), metallic: 0.9, roughness: 0.3 } },
      meshes: [{ id: "socle", geo: "socle", material: "base" }, { id: "anneau", geo: "anneau", material: "or" }],
      nodes,
    }),
    nodes: ["socle_vitrine", "socle", "anneau"],
  };
}

export const MODELS = { "plateau-grille-5x5": plateau, "pions-6": pions, "socle-vitrine": socle };

/** Enveloppe JSON stockée comme ressource : le GLB base64 se range dans un fichier `*.b64` de l'artefact. */
export function envelope(build) {
  const { glb, nodes } = build();
  return JSON.stringify({ format: "glb-base64", glb: glb.toString("base64"), bytes: glb.length, nodes }, null, 2) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [id, build] of Object.entries(MODELS)) {
    writeFileSync(path.join(here, `${id}.json`), envelope(build));
    console.log(`🧊 ${id}.json`);
  }
}
