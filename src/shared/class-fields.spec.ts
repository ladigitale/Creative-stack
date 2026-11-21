/**
 * Lit et Concorde posent les accesseurs réactifs sur le prototype (décorateurs legacy,
 * `static properties`, `@bind`). Un champ de classe compilé en [[Define]] devient une
 * propriété d'instance qui masque l'accesseur : plus de rendu, plus d'écriture dans le
 * DataProvider. Le garde-fou de build de Concorde ne compare qu'une classe à ses propres
 * décorateurs ; il ne voit ni une propriété redéclarée dans une sous-classe (DeviceElement,
 * SonicMlTracker, Sonic3dProps…) ni `static properties`. Ce test regarde les instances :
 * il échoue si les options Oxc de vite.config.mts cessent de s'appliquer, à nos sources
 * comme à celles de Concorde.
 */
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { findShadowedAccessors } from "@supersoniks/concorde/core/utils/shadowedAccessors";

const addonsDir = path.resolve(import.meta.dirname, "../addons");
const addons = readdirSync(addonsDir).filter((id) => existsSync(path.join(addonsDir, id, "index.ts")));

/** Addons dont l'index ne se charge pas sous jsdom (WebGL, workers) : vérifiés en navigateur. */
const skipped: string[] = [];
const registered = new Map<string, string>();

beforeAll(async () => {
  const define = customElements.define.bind(customElements);
  let current = "";
  customElements.define = (name, ctor, options) => {
    registered.set(name, current);
    define(name, ctor, options);
  };
  for (const id of addons) {
    current = id;
    try {
      await import(`../addons/${id}/index.ts`);
    } catch {
      skipped.push(id);
    }
  }
  customElements.define = define;
}, 120_000);

it("charge la plupart des addons sous jsdom", () => {
  expect(registered.size).toBeGreaterThan(60);
  expect(skipped.length).toBeLessThan(addons.length / 3);
});

it("aucun composant n'a de champ qui masque un accesseur réactif", () => {
  const problems: string[] = [];
  for (const [tag, addon] of registered) {
    let element: HTMLElement;
    try {
      element = document.createElement(tag);
    } catch {
      continue; // constructeur qui a besoin d'une API absente de jsdom
    }
    const shadowed = findShadowedAccessors(element);
    if (shadowed.length) problems.push(`${addon} <${tag}> : ${shadowed.join(", ")}`);
  }
  expect(problems).toEqual([]);
});
