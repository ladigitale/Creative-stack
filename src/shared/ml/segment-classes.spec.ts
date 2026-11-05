import { describe, expect, it } from "vitest";
import { SEGMENT_LABELS, combineMasks, foreground, labelsFor, parseList, resolveClasses } from "./segment-classes";

const L = SEGMENT_LABELS["selfie-multiclass"];

describe("labelsFor", () => {
  it("alias connu : ses noms si le nombre de masques colle ; sinon aucun", () => {
    expect(labelsFor("", "selfie-multiclass", 6)).toEqual(L);
    expect(labelsFor("", "selfie-multiclass", 3)).toEqual([]);
    expect(labelsFor("", "https://exemple.org/m.tflite", 6)).toEqual([]);
  });
  it("labels explicite (modèle perso) : accepté s'il colle", () => {
    expect(labelsFor("fond, chat, chien", "x", 3)).toEqual(["fond", "chat", "chien"]);
    expect(labelsFor("fond, chat", "x", 3)).toEqual([]);
  });
});

describe("resolveClasses", () => {
  it("noms (casse et tirets ignorés), indices, doublons, inconnus", () => {
    expect(resolveClasses("hair, Body_Skin 4 hair", L, 6)).toEqual({ indices: [1, 2, 4], unknown: [] });
    expect(resolveClasses("chapeau 9", L, 6)).toEqual({ indices: [], unknown: ["chapeau", "9"] });
    expect(resolveClasses("2", [], 6).indices).toEqual([2]);
    expect(resolveClasses("", L, 6)).toEqual({ indices: [], unknown: [] });
  });
});

describe("foreground", () => {
  it("tout sauf l'arrière-plan", () => {
    expect(foreground(L, 6)).toEqual([1, 2, 3, 4, 5]);
    expect(foreground(["person", "background"], 2)).toEqual([0]);
    expect(foreground([], 3)).toEqual([1, 2]);
    expect(foreground([], 1)).toEqual([]);
  });
});

describe("combineMasks", () => {
  const m = (...d: number[]) => ({ width: 2, height: 2, data: Uint8ClampedArray.from(d) });
  it("maximum pixel par pixel des classes retenues", () => {
    const masks = [m(255, 0, 0, 0), m(0, 200, 0, 10), m(0, 0, 90, 30)];
    expect(Array.from(combineMasks(masks, [1, 2])!.data)).toEqual([0, 200, 90, 30]);
    expect(Array.from(combineMasks(masks, [0])!.data)).toEqual([255, 0, 0, 0]);
  });
  it("indices vides, hors limites ou tailles incohérentes : ignorés", () => {
    expect(combineMasks([m(1, 2, 3, 4)], [])).toBeNull();
    expect(combineMasks([m(1, 2, 3, 4)], [5])).toBeNull();
    const small = { width: 1, height: 1, data: Uint8ClampedArray.from([255]) };
    expect(Array.from(combineMasks([m(1, 2, 3, 4), small], [0, 1])!.data)).toEqual([1, 2, 3, 4]);
  });
});

describe("parseList", () => {
  it("virgules et espaces", () => expect(parseList(" a,b  c ,")).toEqual(["a", "b", "c"]));
});
