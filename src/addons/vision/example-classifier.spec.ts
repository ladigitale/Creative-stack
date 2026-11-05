import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicExampleClassifier } from "./example-classifier";

void SonicExampleClassifier;

/** Sortie de tracker de mains avec une main dont les bouts de doigts sont à la hauteur `reach` (pose « ouverte » ≠ « poing »). */
function handsOut(reach: number, cx = 0.5, scale = 1) {
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: cx + ((i % 4) * 0.01) * scale, y: 0.7 - (i >= 5 ? reach : 0.02) * scale * (i % 5 === 0 ? 0.5 : 1) * 0.3, z: 0 }));
  lm[0] = { x: cx, y: 0.7, z: 0 };
  lm[9] = { x: cx, y: 0.5, z: 0 }; // paume de 0,2
  return { hands: [{ role: "right", landmarks: lm }] };
}

async function mount(attrs: Record<string, string>) {
  const el = document.createElement("sonic-example-classifier") as SonicExampleClassifier;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.innerHTML = "";
});

describe("sonic-example-classifier", () => {
  it("enregistre des exemples, puis reconnaît, indépendamment de la position et de l'échelle", async () => {
    const el = await mount({ id: "c1", "sample-ms": "0", samples: "5", window: "1", features: "hand" });
    el.record("ouverte");
    for (let i = 0; i < 5; i++) el.ingest(handsOut(1.6), i);
    expect(el.getOutput()).toMatchObject({ recording: 0, total: 5, counts: { ouverte: 5 } });
    el.record("poing");
    for (let i = 0; i < 5; i++) el.ingest(handsOut(0.1), 10 + i);
    expect(el.getOutput().counts).toEqual({ ouverte: 5, poing: 5 });

    expect(el.ingest(handsOut(1.6, 0.2, 1.5), 100)).toMatchObject({ present: 1, label: "ouverte", raw: "ouverte" });
    const poing = el.ingest(handsOut(0.1, 0.8, 0.7), 101);
    expect(poing.label).toBe("poing");
    expect(poing.match).toEqual({ ouverte: 0, poing: 1 });
    expect(poing.scores.poing).toBeGreaterThan(0.9);
    expect(dp("c1").get()).toMatchObject({ label: "poing" });
  });

  it("empreintes d'image (features=embed) : apprend et reconnaît des objets par leur vecteur", async () => {
    const el = await mount({ id: "c1e", "sample-ms": "0", samples: "4", window: "1", features: "embed" });
    const vec = (a: number, b: number) => ({ present: 1, dim: 3, vector: [a, b, 0.1] });
    el.record("tasse");
    for (let i = 0; i < 4; i++) el.ingest(vec(0.95 + i * 0.01, 0.05), i);
    el.record("clés");
    for (let i = 0; i < 4; i++) el.ingest(vec(0.05, 0.95 + i * 0.01), 10 + i);
    expect(el.getOutput().counts).toEqual({ tasse: 4, "clés": 4 });
    expect(el.ingest(vec(0.9, 0.1), 100)).toMatchObject({ present: 1, label: "tasse" });
    expect(el.ingest(vec(0.1, 0.9), 101)).toMatchObject({ label: "clés" });
    expect(el.ingest({ present: 0, vector: [], dim: 0 }, 102)).toMatchObject({ present: 0, label: "" });
  });

  it("rien de visible : present 0, étiquette vide, mais les comptes restent", async () => {
    const el = await mount({ id: "c2", "sample-ms": "0", samples: "3" });
    el.record("a");
    for (let i = 0; i < 3; i++) el.ingest(handsOut(1.6), i);
    const out = el.ingest({ hands: [] }, 50);
    expect(out).toMatchObject({ present: 0, label: "", total: 3, counts: { a: 3 } });
  });

  it("sans exemples : aucune étiquette", async () => {
    const el = await mount({ id: "c3" });
    expect(el.ingest(handsOut(1.6), 0)).toMatchObject({ present: 1, label: "", total: 0 });
  });

  it("espacement des exemples : sample-ms", async () => {
    const el = await mount({ id: "c4", "sample-ms": "100", samples: "3" });
    el.record("a");
    el.ingest(handsOut(1.6), 0);
    el.ingest(handsOut(1.6), 50); // trop tôt
    expect(el.getOutput().samplesLeft).toBe(2);
    el.ingest(handsOut(1.6), 120);
    expect(el.getOutput().samplesLeft).toBe(1);
  });

  it("seuils : confiance minimale et distance maximale", async () => {
    const el = await mount({ id: "c5", "sample-ms": "0", samples: "4", window: "1", "max-distance": "0.5" });
    el.record("a");
    for (let i = 0; i < 4; i++) el.ingest(handsOut(1.6), i);
    expect(el.ingest(handsOut(1.6), 10).label).toBe("a");
    expect(el.ingest(handsOut(0.1), 11)).toMatchObject({ label: "", raw: "a" }); // trop loin de tout exemple
  });

  it("lissage : l'étiquette stable ignore un écart isolé", async () => {
    const el = await mount({ id: "c6", "sample-ms": "0", samples: "4", window: "5" });
    el.record("a");
    for (let i = 0; i < 4; i++) el.ingest(handsOut(1.6), i);
    el.record("b");
    for (let i = 0; i < 4; i++) el.ingest(handsOut(0.1), 10 + i);
    for (let i = 0; i < 4; i++) el.ingest(handsOut(1.6), 20 + i);
    const out = el.ingest(handsOut(0.1), 30);
    expect(out.raw).toBe("b");
    expect(out.label).toBe("a");
  });

  it("pilotage par DataProvider : étiquette, compteurs record / clear / clearAll", async () => {
    set("ctl1", { label: "geste", record: 0, clear: 0, clearAll: 0 });
    const el = await mount({ id: "c7", control: "ctl1", "sample-ms": "0", samples: "2" });
    set("ctl1", { label: "geste", record: 1, clear: 0, clearAll: 0 });
    expect(el.getOutput()).toMatchObject({ recording: 1, recordingLabel: "geste", samplesLeft: 2 });
    for (let i = 0; i < 2; i++) el.ingest(handsOut(1.6), i);
    expect(el.getOutput().counts).toEqual({ geste: 2 });
    set("ctl1", { label: "geste", record: 1, clear: 1, clearAll: 0 });
    expect(el.getOutput().total).toBe(0);
    set("ctl1", { label: "x", record: 2, clear: 1, clearAll: 0 });
    for (let i = 0; i < 2; i++) el.ingest(handsOut(1.6), 10 + i);
    set("ctl1", { label: "", record: 2, clear: 1, clearAll: 1 });
    expect(el.getOutput().total).toBe(0);
  });

  it("la première valeur du DataProvider sert de référence (pas d'enregistrement au chargement)", async () => {
    set("ctl2", { label: "a", record: 7, clear: 3, clearAll: 1 });
    const el = await mount({ id: "c8", control: "ctl2" });
    expect(el.getOutput()).toMatchObject({ recording: 0, total: 0 });
  });

  it("mémoire locale : exemples sauvegardés puis rechargés, état corrompu ignoré", async () => {
    const a = await mount({ id: "c9", storage: "test", "sample-ms": "0", samples: "3", window: "1" });
    a.record("a");
    for (let i = 0; i < 3; i++) a.ingest(handsOut(1.6), i);
    a.remove();
    const b = await mount({ id: "c10", storage: "test", window: "1" });
    expect(b.getOutput().counts).toEqual({ a: 3 });
    expect(b.ingest(handsOut(1.6), 0).label).toBe("a");
    b.remove();
    localStorage.setItem("concorde-ml-examples:bad", "{pas du json");
    const c = await mount({ id: "c11", storage: "bad" });
    expect(c.getOutput().total).toBe(0);
  });

  it("source incompatible avec les exemples : l'enregistrement s'arrête sans planter", async () => {
    const el = await mount({ id: "c12", "sample-ms": "0", samples: "3", window: "1" });
    el.record("a");
    el.ingest(handsOut(1.6), 0);
    el.record("b");
    const out = el.ingest({ present: 1, blend: { a: 1, b: 1, c: 1, d: 1, e: 1 } }, 5); // 5 valeurs au lieu de 42
    expect(out.samplesLeft).toBe(0);
    expect(el.getOutput().counts).toEqual({ a: 1 });
  });

  it("abonnement à la sortie d'un tracker", async () => {
    const el = await mount({ id: "c13", source: "trk", "sample-ms": "0", samples: "2", window: "1" });
    el.record("a");
    set("trk", handsOut(1.6));
    set("trk", handsOut(1.6, 0.3));
    expect(el.getOutput().counts).toEqual({ a: 2 });
  });
});
