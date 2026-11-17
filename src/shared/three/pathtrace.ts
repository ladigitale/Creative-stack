import * as THREE from "three";

/**
 * Communs du rendu « photo » en lancer de rayons progressif (three-gpu-pathtracer, chargé à la demande) : partagés
 * par le format monde de `sonic-3d` (`3d/photo.ts`) et par `sonic-procgen` (`procgen/render/photo.ts`).
 */

export type PT = typeof import("three-gpu-pathtracer");
export type Tracer = InstanceType<PT["WebGLPathTracer"]>;

/** État publié du rendu photo. */
export type PhotoState = {
  etat: "arret" | "attente" | "calcul" | "fini" | "indisponible";
  echantillons: number;
  total: number;
  raison?: string;
};

/** Au-delà, la scène dépliée est trop lourde pour le traceur (mémoire du BVH). */
export const MAX_TRACE_TRIS = 2_500_000;

let modPromise: Promise<PT> | null = null;
/** Module du traceur, chargé une fois (import dynamique : aucun coût tant que le rendu photo n'est pas demandé). */
export function loadPathTracer(): Promise<PT> {
  return (modPromise ??= import("three-gpu-pathtracer"));
}

/** Quad plein écran pour une matière de passe (caméra orthographique unité : marche aussi avec projectionMatrix). */
export function fullscreen(mat: THREE.ShaderMaterial) {
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  cam.position.z = 0.5;
  cam.updateMatrixWorld();
  return { quad, scene, cam, mat };
}

/** Signature d'état (évite de republier un état identique). */
export const photoStateSig = (s: PhotoState) => `${s.etat}|${s.echantillons}|${s.total}|${s.raison ?? ""}`;

/** Appareil tactile sans souris (téléphone, tablette) : GPU plus modeste, écran très dense. */
export function isHandheld(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
  } catch {
    return false;
  }
}

/**
 * Pixels tracés et découpage en tuiles : chaque passe du traceur doit rester courte (sinon le navigateur d'un
 * téléphone coupe le contexte graphique) et les cibles flottantes tenir en mémoire.
 */
export function tracingBudget(renderer: { getDrawingBufferSize(v: THREE.Vector2): THREE.Vector2 }, echelle: number, handheld: boolean) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const px = Math.max(1, size.x * size.y);
  const scale = Math.max(0.1, Math.min(echelle, Math.sqrt((handheld ? 350_000 : 1_600_000) / px)));
  const traced = px * scale * scale;
  const tiles = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(traced / (handheld ? 90_000 : 500_000)))));
  return { scale, tiles };
}
