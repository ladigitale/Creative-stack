/// <reference path="./jsonata-file.d.ts" />
/**
 * Remplaçant du module `jsonata` pour les applications qui veulent les fonctions
 * creative-stack dans **toutes** les expressions (dont `sonic-jsonata` de Concorde) :
 *
 * ```ts
 * // vite.config
 * resolve: { alias: [{ find: /^jsonata$/, replacement: "@supersoniks/creative-stack/jsonata" }] }
 * ```
 *
 * Importe la vraie lib par son fichier (`jsonata/jsonata.js`) pour ne pas boucler sur l'alias.
 * À retirer le jour où Concorde exposera un `registerJsonataFunction`.
 */
import realJsonata from "jsonata/jsonata.js";
import type { Expression } from "jsonata";
import { registerCreativeJsonataHelpers } from "./jsonata-helpers";

type JsonataFactory = (source: string, options?: unknown) => Expression;

const factory = realJsonata as unknown as JsonataFactory;

function jsonata(source: string, options?: unknown): Expression {
  return registerCreativeJsonataHelpers(factory(source, options));
}

export default jsonata as unknown as typeof realJsonata;
