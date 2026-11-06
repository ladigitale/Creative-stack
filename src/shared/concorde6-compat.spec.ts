// @vitest-environment jsdom
/**
 * Contrat « store immutable » de Concorde 6 (set = copie + gel, get = valeur gelée) tel que creative-stack en dépend.
 * Si l'un de ces tests casse après une mise à jour de Concorde, un addon publie ou lit probablement ses données
 * d'une manière qui n'est plus valable : corriger l'addon, pas le test.
 *
 * Vérifié dans Chrome (Concorde 6.0.0, 6 nov. 2026), non reproductible sous jsdom (son structuredClone ne rejette
 * pas les objets DOM et vide les Blob) :
 * - un Blob publié reste un Blob (même taille) ; un élément DOM et une fonction restent passés par référence,
 *   non gelés ; les tableaux typés (Float32Array…) passent ;
 * - un jeton média mêlant `blob` et `element` garde les deux ;
 * - coût d'un `set` : ~0,65 ms pour 2 visages de 468 points (30 Hz ≈ 2 % d'un cœur), ~0,18 ms pour 200 nœuds.
 */
import { describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "./audio/dp";

let n = 0;
const name = () => `c6compat${++n}`;

describe("Concorde 6 : lecture", () => {
  it("get() renvoie une valeur gelée : la muter lève une erreur", () => {
    const path = name();
    set(path, { items: [1, 2, 3], nested: { a: 1 } });
    const v = dp(path).get() as { items: number[]; nested: { a: number } };
    expect(Object.isFrozen(v)).toBe(true);
    expect(() => {
      v.nested.a = 2;
    }).toThrow(TypeError);
    expect(() => v.items.push(4)).toThrow(TypeError);
    expect(() => v.items.sort()).toThrow(TypeError);
  });

  it("listenDp (plain) donne aux addons une copie modifiable, sans toucher au store", () => {
    const path = name();
    let received: { a: number; list: number[] } | null = null;
    const off = listenDp(path, (v) => {
      received = v as { a: number; list: number[] };
    });
    set(path, { a: 1, list: [3, 1, 2] });
    expect(received).not.toBeNull();
    expect(Object.isFrozen(received)).toBe(false);
    received!.a = 99;
    received!.list.sort();
    expect((dp(path).get() as { a: number; list: number[] }).a).toBe(1);
    expect((dp(path).get() as { a: number; list: number[] }).list).toEqual([3, 1, 2]);
    off();
  });

  it("plain() produit une copie profonde modifiable d'une valeur gelée", () => {
    const frozen = Object.freeze({ k: Object.freeze([1, 2]) });
    const copy = plain<{ k: number[] }>(frozen);
    expect(Object.isFrozen(copy)).toBe(false);
    copy.k.push(3);
    expect(copy.k).toEqual([1, 2, 3]);
  });
});

describe("Concorde 6 : écriture", () => {
  it("set() prend possession : modifier l'objet d'origine ensuite ne change pas le store", () => {
    const path = name();
    const state = { x: 1, tags: ["a"] };
    set(path, state);
    state.x = 2; // le producteur ne doit PAS compter sur la référence partagée
    state.tags.push("b");
    expect(dp(path).get()).toEqual({ x: 1, tags: ["a"] });
  });

  it("republier un nouvel objet à chaque tick est la seule façon de publier un changement", () => {
    const path = name();
    const seen: number[] = [];
    const off = listenDp(path, (v) => seen.push((v as { t: number }).t));
    for (let t = 1; t <= 3; t++) set(path, { t });
    expect(seen.slice(-3)).toEqual([1, 2, 3]);
    off();
  });

  it("PIÈGE : une instance de classe avec seulement des données perd ses méthodes", () => {
    // structuredClone ne garde pas le prototype. Ne jamais publier d'instance : publier des données simples.
    class Thing {
      a = 1;
      hello() {
        return "hi";
      }
    }
    const path = name();
    set(path, { thing: new Thing() });
    const v = dp(path).get() as { thing: { a: number; hello?: () => string } };
    expect(v.thing.a).toBe(1);
    expect(v.thing.hello).toBeUndefined();
  });
});
