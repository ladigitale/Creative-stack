/**
 * Accès au module procgen depuis d'autres addons (`sonic-3d`, `sonic-2d` : modèles `gen` du format monde), sans le
 * dupliquer :
 *
 * - l'addon procgen s'enregistre (`registerProcgen`) dès qu'il est chargé ;
 * - sinon, en ES / application, il est importé à la demande (chunk séparé) ;
 * - dans les bundles autonomes (IIFE), il n'est jamais embarqué : la page charge `creative-stack-procgen.bundle.js`.
 */
import type { GenActor, GenKit, GenSprite } from "../addons/procgen/index";

export type ProcgenApi = { GenKit: typeof GenKit; GenActor: typeof GenActor; GenSprite: typeof GenSprite };

type Holder = { __creativeStackProcgen?: ProcgenApi };

declare global {
  interface ImportMeta {
    readonly env?: { readonly CS_IIFE?: boolean };
  }
}

export function registerProcgen(api: ProcgenApi): void {
  (globalThis as Holder).__creativeStackProcgen ??= api;
}

let pending: Promise<ProcgenApi> | null = null;

export function loadProcgen(): Promise<ProcgenApi> {
  const ready = (globalThis as Holder).__creativeStackProcgen;
  if (ready) return Promise.resolve(ready);
  if (import.meta.env?.CS_IIFE) {
    return Promise.reject(new Error("addon procgen absent : charger creative-stack-procgen.bundle.js avant ce bundle"));
  }
  pending ??= import("../addons/procgen/index").then((m) => {
    const api = { GenKit: m.GenKit, GenActor: m.GenActor, GenSprite: m.GenSprite };
    registerProcgen(api);
    return api;
  });
  return pending;
}
