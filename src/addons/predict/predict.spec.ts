import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { detectTask, prepare, split, toNumber, encodeRow } from "./data";
import { Trainer } from "./train";
import { loadModel, predictRow } from "./model";
import { rng } from "../paint/brush";

const run = (t: Trainer) => { while (!t.done) t.step(); return t; };

function regressionRows(n = 300) {
  const r = rng(5);
  return Array.from({ length: n }, () => {
    const a = r() * 10, b = r() * 10, c = r() * 10;
    return { a, b, noise: c, ville: r() < 0.5 ? "Tours" : "Paris", y: 3 * a - 2 * b + 5 + (r() - 0.5) * 0.2 };
  });
}

function classRows(n = 400) {
  const r = rng(9);
  return Array.from({ length: n }, () => {
    const x = r() * 10, z = r() * 10;
    return { x, z, junk: r(), label: x + z > 10 ? "grand" : "petit" };
  });
}

describe("csv", () => {
  it("lit guillemets, séparateur ; et retours dans un champ", () => {
    const { columns, rows } = parseCsv('nom;note;com\r\n"Dupont; Jean";12,5;"a ""b""\nc"\nMartin;9;ok\n');
    expect(columns).toEqual(["nom", "note", "com"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ nom: "Dupont; Jean", note: "12,5", com: 'a "b"\nc' });
  });
  it("noms de colonnes vides ou doublons, BOM, erreurs", () => {
    expect(parseCsv("﻿a,a,\n1,2,3").columns).toEqual(["a", "a_2", "col3"]);
    expect(() => parseCsv("a,b")).toThrow();
    expect(() => parseCsv("x".repeat(9_000_000))).toThrow(/trop gros/);
  });
});

describe("préparation des données", () => {
  it("lit les nombres à la française", () => {
    expect([toNumber("12,5"), toNumber(" 3 "), toNumber("1e3"), toNumber("45%"), toNumber("abc"), toNumber(""), toNumber(true)]).toEqual([12.5, 3, 1000, 45, NaN, NaN, 1]);
  });
  it("détecte la tâche", () => {
    expect(detectTask(regressionRows(50), "y")).toBe("regression");
    expect(detectTask(classRows(50), "label")).toBe("classification");
    expect(detectTask([{ n: 0 }, { n: 1 }, { n: 1 }, { n: 0 }], "n")).toBe("classification");
  });
  it("types, encodage et colonnes ignorées", () => {
    const rows = regressionRows(60).map((r, i) => ({ ...r, id: `id${i}`, cst: 1, vide: "" }));
    const ds = prepare(rows, { target: "y" });
    expect(ds.features.map((f) => f.name).sort()).toEqual(["a", "b", "noise", "ville"]);
    expect(ds.ignored.map((i) => i.name).sort()).toEqual(["cst", "id", "vide"]);
    expect(ds.dim).toBe(5);
    const out = new Float64Array(ds.dim);
    const missing = encodeRow(ds.features, { a: "x", ville: "Inconnue" }, out, 0);
    expect(missing).toBe(4);
  });
  it("refuse les données inutilisables", () => {
    expect(() => prepare([], { target: "y" })).toThrow();
    expect(() => prepare(regressionRows(20), { target: "absent" })).toThrow(/introuvable/);
    expect(() => prepare(regressionRows(5), { target: "y" })).toThrow(/10 lignes/);
    expect(() => prepare(Array.from({ length: 20 }, (_, i) => ({ k: i, c: "a" })), { target: "c" })).toThrow(/une seule valeur/);
  });
  it("le découpage est reproductible et complet", () => {
    const a = split(100, 0.2, 3), b = split(100, 0.2, 3);
    expect(a).toEqual(b);
    expect(a.test).toHaveLength(20);
    expect(new Set([...a.train, ...a.test]).size).toBe(100);
  });
});

describe("entraînement", () => {
  it("la régression retrouve une relation linéaire (R² élevé, bat la ligne de base)", () => {
    const t = run(new Trainer(regressionRows(), { target: "y", kind: "linear", epochs: 300, learningRate: 0.05, seed: 2 }));
    const m = t.metrics();
    expect(m.task).toBe("regression");
    if (m.task === "regression") {
      expect(m.r2).toBeGreaterThan(0.98);
      expect(m.rmse).toBeLessThan(m.baselineRmse / 5);
    }
    const imp = t.importance();
    expect(imp.map((i) => i.name).slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(imp.find((i) => i.name === "noise")!.importance).toBeLessThan(0.05);
    expect(imp.reduce((s, i) => s + i.importance, 0)).toBeCloseTo(1, 6);
  });
  it("la classification apprend une frontière non triviale avec un MLP", () => {
    const t = run(new Trainer(classRows(), { target: "label", kind: "mlp", hidden: 12, epochs: 200, seed: 4 }));
    const m = t.metrics();
    expect(m.task).toBe("classification");
    if (m.task === "classification") {
      expect(m.accuracy).toBeGreaterThan(0.93);
      expect(m.accuracy).toBeGreaterThan(m.baselineAccuracy);
      expect(m.confusion.flat().reduce((a, b) => a + b, 0)).toBe(m.n);
    }
    expect(t.importance().find((i) => i.name === "junk")!.importance).toBeLessThan(0.1);
  });
  it("la courbe d'apprentissage descend et l'entraînement est reproductible", () => {
    const mk = () => run(new Trainer(regressionRows(120), { target: "y", epochs: 40, seed: 7 }));
    const a = mk(), b = mk();
    expect(a.curve).toHaveLength(40);
    expect(a.curve[39].trainLoss).toBeLessThan(a.curve[0].trainLoss);
    expect(a.curve).toEqual(b.curve);
  });
  it("borne les réglages absurdes", () => {
    const t = new Trainer(regressionRows(50), { target: "y", epochs: 1e9, hidden: 1e6, learningRate: -3, testSplit: 9 });
    expect(t.epochs).toBe(2000);
    expect(t.net.dims[1]).toBe(128);
    expect(t.test.length).toBeLessThanOrEqual(25);
  });
});

describe("modèle", () => {
  it("fait l'aller-retour JSON et prédit pareil", () => {
    const t = run(new Trainer(classRows(200), { target: "label", epochs: 60, seed: 1 }));
    const json = JSON.parse(JSON.stringify(t.model()));
    const { model, net } = loadModel(json);
    const p = predictRow(model, net, { x: 9, z: 9, junk: 0.3 });
    expect(p).toMatchObject({ task: "classification", label: "grand" });
    if (p.task === "classification") expect(Object.values(p.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    const q = predictRow(model, net, { x: 1, z: 1 });
    expect(q).toMatchObject({ label: "petit" });
    expect(q.missing).toBe(1);
  });
  it("régression : rend la valeur dans l'unité d'origine", () => {
    const t = run(new Trainer(regressionRows(), { target: "y", kind: "linear", epochs: 300, learningRate: 0.05 }));
    const { model, net } = loadModel(JSON.parse(JSON.stringify(t.model())));
    const p = predictRow(model, net, { a: 5, b: 2, noise: 3, ville: "Tours" });
    expect(p.task === "regression" && Math.abs(p.value - 16) < 1).toBe(true);
  });
  it("rejette les modèles malformés", () => {
    const good = JSON.parse(JSON.stringify(run(new Trainer(classRows(60), { target: "label", epochs: 2 })).model()));
    const bad = (f: (m: Record<string, any>) => void) => { const m = JSON.parse(JSON.stringify(good)); f(m); return () => loadModel(m); };
    expect(() => loadModel(null)).toThrow();
    expect(() => loadModel({ format: "autre" })).toThrow(/format/);
    expect(bad((m) => (m.dims[0] = 99))).toThrow(/incohérente/);
    expect(bad((m) => m.weights[0].pop())).toThrow(/taille/);
    expect(bad((m) => (m.weights[0][0] = "x"))).toThrow(/non numériques/);
    expect(bad((m) => (m.features[0].std = 0))).toThrow(/invalide/);
    expect(bad((m) => (m.dims = [m.dims[0], 5000, m.dims[2]]))).toThrow();
    expect(() => loadModel(good)).not.toThrow();
  });
});
