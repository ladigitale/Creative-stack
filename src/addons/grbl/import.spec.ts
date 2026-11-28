import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import type { SonicLaserImport } from "./import";
import type { SonicGcode } from "./gcode";

const wait = async (ok: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!ok() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 10));
};
const dataUrl = (text: string, mime = "text/plain") => `data:${mime};base64,${Buffer.from(text, "latin1").toString("base64")}`;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("sonic-laser-import", () => {
  it("ouvre un DXF et le donne à sonic-gcode", async () => {
    const dxf = "  0\nSECTION\n  2\nENTITIES\n  0\nCIRCLE\n  8\n0\n 62\n1\n 10\n0\n 20\n0\n 40\n10\n  0\nENDSEC\n  0\nEOF\n";
    set("fichierDxf", null);
    document.body.insertAdjacentHTML("beforeend", '<sonic-laser-import id="imp" from="fichierDxf" drawing-provider="dessinDxf"></sonic-laser-import><sonic-gcode id="progImp" svg-from="dessinDxf" mode="skip" ops=\'[{"color":"#ff0000","mode":"line","power":80,"speed":300,"passes":1}]\'></sonic-gcode>');
    const imp = document.getElementById("imp") as unknown as SonicLaserImport;
    const prog = document.getElementById("progImp") as unknown as SonicGcode;
    await imp.updateComplete;
    set("fichierDxf", { url: dataUrl(dxf), name: "rond.dxf", mime: "" });
    await wait(() => imp.getState().ready);
    expect(imp.getState()).toMatchObject({ status: "ready", format: "dxf", kind: "vector", colors: ["#ff0000"], seq: 1 });
    expect(imp.getState().widthMm).toBeCloseTo(20, 1);
    expect(String((get("dessinDxf") as { svg: string }).svg)).toContain('width="20mm"');
    await prog.updateComplete;
    expect(await prog.run("build")).toBe(true);
    expect(prog.getState().sizeMm?.w).toBeCloseTo(20, 0);
  });

  it("passe un G-code tel quel, sans les commandes $", async () => {
    set("fichierNc", null);
    document.body.insertAdjacentHTML("beforeend", '<sonic-laser-import id="imp2" from="fichierNc" drawing-provider="progNc"></sonic-laser-import><sonic-gcode id="prog2" svg-from="progNc"></sonic-gcode>');
    const imp = document.getElementById("imp2") as unknown as SonicLaserImport;
    const prog = document.getElementById("prog2") as unknown as SonicGcode;
    await imp.updateComplete;
    set("fichierNc", { url: dataUrl("$32=1\nG21\nG90\nM4 S0\nG0 X0 Y0\nG1 X10 S500 F600 ; trait\nM5\n"), name: "job.nc" });
    await wait(() => imp.getState().ready);
    expect(imp.getState()).toMatchObject({ format: "gcode", kind: "program", lines: 6 });
    await prog.updateComplete;
    expect(await prog.run("build")).toBe(true);
    expect(prog.getGcode()).toEqual(["G21", "G90", "M4 S0", "G0 X0 Y0", "G1 X10 S500 F600", "M5"]);
    expect(prog.getState()).toMatchObject({ kind: "program", ready: true, burnMm: 10 });
  });

  it("refuse un format fermé avec un conseil", async () => {
    set("fichierCdr", null);
    document.body.insertAdjacentHTML("beforeend", '<sonic-laser-import id="imp3" from="fichierCdr"></sonic-laser-import>');
    const imp = document.getElementById("imp3") as unknown as SonicLaserImport;
    await imp.updateComplete;
    set("fichierCdr", { url: dataUrl("RIFF0000CDR"), name: "logo.cdr" });
    await wait(() => imp.getState().status === "error");
    expect(imp.getState().error).toMatch(/CorelDraw/);
    expect(imp.getState().accept).toContain(".dxf");
  });
});
