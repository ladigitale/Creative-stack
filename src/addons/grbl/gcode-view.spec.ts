import { afterEach, describe, expect, it } from "vitest";
import "./index";
import "../interactive";
import { gridSteps, parseProgram } from "./index";
import type { SonicGcodeView } from "./gcode-view";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("sonic-gcode-view", () => {
  it("lit le programme en segments : couleurs d'opération, niveaux, déplacements à vide, lignes préparées", () => {
    const p = parseProgram(["; titre", "G90", "M4", ";op #e11d48", "G0X5Y5", "", "G1X15Y5S1000F600", "G1X15Y10S250", ";op #ffffff", "G1X5Y10", "M5", "G0X0Y0"]);
    expect(p.count).toBe(5);
    expect(p.lines).toBe(8);
    expect(Array.from(p.level.slice(0, 5))).toEqual([-1, 3, 1, 1, -1]);
    expect(p.colors).toEqual(["#141414", "#e11d48"]);
    expect(Array.from(p.color.slice(0, 5))).toEqual([1, 1, 1, 0, 0]);
    expect(Array.from(p.line.slice(0, 5))).toEqual([2, 3, 4, 5, 7]);
    expect(p.bbox).toEqual({ x: 5, y: 5, w: 10, h: 5 });
  });

  it("sans faisceau allumé, l'emprise est celle des mouvements de travail", () => {
    expect(parseProgram(["G0X50Y50", "G1X60Y55F500", "G1X70Y50"]).bbox).toEqual({ x: 50, y: 50, w: 20, h: 5 });
    expect(parseProgram(["G91", "G1X5Y0F100", "G1X5Y5"]).bbox).toEqual({ x: 0, y: 0, w: 10, h: 5 });
  });

  it("choisit des pas de grille ronds", () => {
    expect(gridSteps(10)).toEqual({ major: 10, minor: 2 });
    expect(gridSteps(1)).toEqual({ major: 100, minor: 20 });
    expect(gridSteps(100)).toEqual({ major: 1, minor: 0.2 });
    expect(gridSteps(30)).toEqual({ major: 5, minor: 1 });
  });

  it("suit la source, publie l'emprise et le plateau décalé de l'origine posée", async () => {
    const src = Object.assign(document.createElement("div"), { id: "prog", gcodeSeq: 1, getGcode: () => ["G90", "M4", "G0X10Y10", "G1X40Y10S500F900", "G1X40Y30"] });
    document.body.append(src);
    const { set } = await import("@supersoniks/concorde/core/utils/PublisherProxy");
    set("gvLaser", { connected: true, pos: { x: 5, y: 5 }, mpos: { x: 105, y: 55 }, job: null });
    document.body.insertAdjacentHTML("beforeend", `<sonic-gcode-view id="vue" source="#prog" machine="atomstack-a5-pro" state-from="gvLaser" style="width:400px;height:300px"></sonic-gcode-view>`);
    const el = document.querySelector("sonic-gcode-view") as SonicGcodeView;
    await el.updateComplete;
    await wait(300);
    const st = get("vueState") as { status: string; bbox: unknown; bed: unknown; segments: number };
    expect(st.status).toBe("ready");
    expect(st.bbox).toEqual({ x: 10, y: 10, w: 30, h: 20 });
    expect(st.bed).toEqual({ x: -100, y: -50, w: 410, h: 400 });
    expect(st.segments).toBe(3);

    Object.assign(src, { gcodeSeq: 2, getGcode: () => ["G0X0Y0", "M4", "G1X5Y0S100F100"] });
    await wait(300);
    expect((get("vueState") as { bbox: unknown }).bbox).toEqual({ x: 0, y: 0, w: 5, h: 0 });
    src.remove();
    await wait(300);
    expect((get("vueState") as { status: string }).status).toBe("empty");
  });
});
