/**
 * Cartes des finis texturés de procgen : une banque de hauteurs (texture en couches, une couche par motif du format
 * monde, mêmes hauteurs que les cartes de normales / ORM de `sonic-3d` : `texHeights`), et la table par rôle
 * (`uRoleFin`). Rien n'est créé tant qu'aucun fini texturé n'est demandé.
 */
import * as THREE from "three";
import { texHeights, type TexSpec } from "../../../shared/monde/textures";
import { ROLES } from "../style/roles";
import { FIN_ROWS, encodeRoleTex, type FinishMotif, type RoleFinishes } from "../style/finishes";

/** Écran tactile ou petit écran : qualité basse des finis texturés (et du post-traitement en `auto`). */
export const isMobileScreen = () =>
  typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches || Math.min(window.screen?.width ?? 2000, window.screen?.height ?? 2000) < 700);

/** Couches au plus (au-delà, les motifs suivants reprennent la dernière). */
export const MAX_MOTIFS = 8;

export class HeightBank {
  private keys: string[] = [];
  private specs: FinishMotif[] = [];
  private dirty = false;
  /** `uniform` : celui des matériaux (`uHeights`) ; `size` : côté d'une couche. */
  constructor(
    readonly uniform: THREE.IUniform = { value: null },
    private size = 256,
  ) {}

  /** Couche d'un motif (réservée si nouvelle ; la texture est refaite au prochain `update`). */
  layerOf = (m: FinishMotif): number => {
    const key = `${m.kind}|${m.seed}`;
    const i = this.keys.indexOf(key);
    if (i >= 0) return i;
    if (this.keys.length >= MAX_MOTIFS) return MAX_MOTIFS - 1;
    this.keys.push(key);
    this.specs.push(m);
    this.dirty = true;
    return this.keys.length - 1;
  };

  /** Refait la texture si des motifs ont été ajoutés. */
  update() {
    if (!this.dirty) return;
    this.dirty = false;
    const S = this.size, n = this.keys.length;
    const data = new Uint8Array(S * S * n);
    this.specs.forEach((m, k) => data.set(texHeights({ kind: m.kind, seed: m.seed, scale: 1, angle: 0, color2: "", contrast: 1 } as TexSpec, S), k * S * S));
    const tx = new THREE.DataArrayTexture(data, S, S, n);
    tx.format = THREE.RedFormat;
    tx.type = THREE.UnsignedByteType;
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    tx.magFilter = THREE.LinearFilter;
    tx.minFilter = THREE.LinearMipmapLinearFilter;
    tx.generateMipmaps = true;
    tx.needsUpdate = true;
    (this.uniform.value as THREE.Texture | null)?.dispose();
    this.uniform.value = tx;
  }

  get motifs(): number {
    return this.keys.length;
  }

  dispose() {
    (this.uniform.value as THREE.Texture | null)?.dispose();
    this.uniform.value = null;
    this.keys = [];
    this.specs = [];
  }
}

/** Table par rôle des finis texturés (`uRoleFin`) et son interrupteur (`uFinOn` : 0 aucun, 1 qualité basse, 2 haute). */
export class RoleFinTable {
  readonly tex: THREE.DataTexture;
  private data = new Float32Array(ROLES.length * FIN_ROWS * 4);
  /** `texUniform` (`uRoleFin`) et `on` (`uFinOn`) : uniformes des matériaux qui lisent cette table. */
  constructor(
    texUniform: THREE.IUniform,
    readonly on: THREE.IUniform,
  ) {
    this.tex = new THREE.DataTexture(this.data, ROLES.length, FIN_ROWS, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    texUniform.value = this.tex;
  }
  /** Recalcule la table ; `quality` 1 basse (mobile), 2 haute. */
  set(bank: HeightBank, quality: 1 | 2, ...layers: RoleFinishes[]) {
    const { data, on } = encodeRoleTex(bank.layerOf, ...layers);
    this.data.set(data);
    this.tex.needsUpdate = true;
    if (on) bank.update();
    this.on.value = on ? quality : 0;
  }
  dispose() {
    this.tex.dispose();
  }
}
