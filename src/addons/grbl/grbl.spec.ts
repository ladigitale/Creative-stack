import { afterEach, describe, expect, it } from "vitest";
import "./index";
import {
  analyzeGcode, checkLine, cleanLine, cleanOp, GrblLink, hatch, hexColor, num, orderPaths, parseGrblLine, parseStatus, prepareJob, rasterToGcode, RT, RX_BUFFER,
  svgToGcode, TOOLPATH_DEFAULTS, type GrblMessage,
} from "./index";
import { FakePipe } from "../../shared/pipe/fake-pipe";
import { burnPoints, convexHull, dryRunLines, frameLines, modalAt, resumeHint, resumeLines } from "./jobs";
import type { SonicGrbl } from "./grbl";
import type { SonicGcode } from "./gcode";

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (d: Uint8Array) => new TextDecoder().decode(d);

afterEach(() => {
  document.body.innerHTML = "";
});

// ─── Machine GRBL simulée sur un faux canal ──────────────────────────────────────────────────────────────────────
type Sim = { pipe: FakePipe; lines: string[]; realtime: number[]; state: string; settings: Record<number, number>; failOn: RegExp | null; silent: boolean; alarmOn: RegExp | null };

function simulator(settings: Record<number, number> = { 22: 0, 30: 1000, 32: 1, 110: 6000, 111: 6000, 130: 410, 131: 400 }): Sim {
  const sim: Sim = { pipe: new FakePipe("CH340 1a86:7523"), lines: [], realtime: [], state: "Idle", settings, failOn: null, silent: false, alarmOn: null };
  sim.pipe.respond = (data) => {
    if (sim.silent) return null;
    if (data.length === 1 && (data[0] < 0x20 || data[0] > 0x7e || "?!~".includes(String.fromCharCode(data[0])))) {
      sim.realtime.push(data[0]);
      if (data[0] === RT.STATUS) return enc(`<${sim.state}${sim.state === "Hold" ? ":0" : ""}|MPos:10.000,20.000,0.000|FS:0,0|WCO:10.000,5.000,0.000>\r\n`);
      if (data[0] === RT.HOLD) sim.state = "Hold";
      if (data[0] === RT.RESUME) sim.state = "Idle";
      if (data[0] === RT.RESET) {
        sim.state = "Idle";
        return enc("\r\nGrbl 1.1h ['$' for help]\r\n");
      }
      return null;
    }
    const line = dec(data).trim();
    sim.lines.push(line);
    if (line === "$I") return enc("[VER:1.1h.20190825:]\r\n[OPT:V,15,128]\r\nok\r\n");
    if (line === "$$") return enc(Object.entries(sim.settings).map(([k, v]) => `$${k}=${v}`).join("\r\n") + "\r\nok\r\n");
    if (sim.alarmOn?.test(line)) {
      sim.state = "Alarm";
      return enc("ALARM:2\r\nok\r\n");
    }
    if (sim.failOn?.test(line)) return enc("error:20\r\n");
    return enc("ok\r\n");
  };
  return sim;
}

async function mountGrbl(sim: Sim, attrs = ""): Promise<SonicGrbl> {
  const transport = Object.assign(document.createElement("div"), { id: "port" });
  Object.defineProperties(transport, {
    pipeReady: { get: () => sim.pipe.pipeReady },
    deviceName: { get: () => sim.pipe.deviceName },
  });
  Object.assign(transport, { writeBytes: sim.pipe.writeBytes.bind(sim.pipe), onBytes: sim.pipe.onBytes.bind(sim.pipe) });
  document.body.append(transport);
  document.body.insertAdjacentHTML("beforeend", `<sonic-grbl id="laser" transport="#port" time-scale="0" ${attrs}></sonic-grbl>`);
  const el = document.querySelector("sonic-grbl") as SonicGrbl;
  await el.updateComplete;
  await wait(180);
  return el;
}

describe("codec GRBL", () => {
  it("lit les réponses", () => {
    expect(parseGrblLine("ok")).toEqual({ type: "ok" });
    expect(parseGrblLine("error:20")).toMatchObject({ type: "error", code: 20, message: "commande G-code inconnue" });
    expect(parseGrblLine("ALARM:3")).toMatchObject({ type: "alarm", code: 3 });
    expect(parseGrblLine("Grbl 1.1h ['$' for help]")).toEqual({ type: "welcome", version: "1.1h" });
    expect(parseGrblLine("$130=410.000")).toEqual({ type: "setting", id: 130, value: 410 });
    expect(parseGrblLine("[MSG:Caution: Unlocked]")).toEqual({ type: "info", tag: "MSG", text: "Caution: Unlocked" });
    expect(parseGrblLine("bruit")).toEqual({ type: "other", text: "bruit" });
  });

  it("lit un rapport d'état", () => {
    expect(parseStatus("<Hold:0|MPos:1.500,-2.000,0.000|FS:1200,300|Bf:14,120|Pn:XY|WCO:1.000,0.000,0.000>")).toEqual({
      state: "Hold", sub: 0, mpos: [1.5, -2, 0], feed: 1200, power: 300, buffer: { planner: 14, rx: 120 }, pins: "XY", wco: [1, 0, 0],
    });
    expect(parseStatus("<Idle|WPos:0.000,0.000,0.000>")).toMatchObject({ state: "Idle", sub: null, wpos: [0, 0, 0] });
    expect(parseStatus("ok")).toBeNull();
  });

  it("nettoie et vérifie les lignes", () => {
    expect(cleanLine(" g1 x10 y5 (coupe) ; fin")).toBe("G1X10Y5");
    expect(cleanLine("; commentaire")).toBe("");
    expect(checkLine("G1X10Y5S500F1000")).toBeNull();
    expect(checkLine("$$")).toBeNull();
    expect(checkLine("$J=G91G21X10F2000")).toBeNull();
    expect(checkLine("$32=0")).toContain("réglage");
    expect(checkLine("$32=0", { settings: true })).toBeNull();
    expect(checkLine("$RST=*")).toBe("commande $ refusée");
    expect(checkLine("$N0=M3S1000")).toBe("commande $ refusée");
    expect(checkLine("$H", { dollar: false })).toContain("tâche");
    expect(checkLine("G1X1\u0018")).toBe("caractère hors G-code");
    expect(checkLine("G1" + "X1".repeat(60))).toContain("trop longue");
    expect(num(1.23456)).toBe("1.235");
    expect(num(-0.0001)).toBe("0");
    expect(num(10)).toBe("10");
  });

  it("prépare une tâche : M3 remplacé, puissance plafonnée, commandes $ refusées", () => {
    const job = prepareJob("G90\n; titre\nM3 S1000\nG1 X10 F600 S900\nM03\nM30\nM5\n", { tool: "laser", maxS: 500 });
    expect(job.error).toBeNull();
    expect(job.lines).toEqual(["G90", "M4S500", "G1X10F600S500", "M4", "M30", "M5"]);
    expect(job.issues.length).toBe(2);
    expect(prepareJob("G1X1\n$32=0", { tool: "laser", maxS: 0 }).error).toContain("ligne 2");
    expect(prepareJob("M3S100", { tool: "pen", maxS: 0 }).lines).toEqual(["M3S100"]);
    expect(prepareJob("\n;\n", { tool: "laser", maxS: 0 }).error).toBe("programme vide");
  });

  it("mesure un programme", () => {
    const s = analyzeGcode(["G90", "G21", "M4S0", "G0X10Y10", "G1X20Y10S800F600", "G1X20Y20", "M5", "G0X0Y0"], 3000);
    expect(s.bbox).toEqual({ x: 0, y: 0, w: 20, h: 20 });
    expect(s.maxS).toBe(800);
    expect(s.burnMm).toBe(20);
    expect(s.travelMm).toBeCloseTo(42.4, 1);
    expect(s.estimateS).toBe(3);
    expect(s.hasM3).toBe(false);
    expect(analyzeGcode(["G91", "G1X5F100S1"]).relative).toBe(true);
  });
});

describe("GrblLink", () => {
  it("ne remplit jamais le tampon de la machine au-delà de sa taille", async () => {
    const pipe = new FakePipe();
    let pending = 0, peak = 0;
    const sizes: number[] = [];
    pipe.respond = (data) => {
      sizes.push(data.length);
      pending += data.length;
      peak = Math.max(peak, pending);
      return null;
    };
    const link = new GrblLink(pipe, () => undefined, 0);
    const lines = Array.from({ length: 40 }, (_, i) => `G1X${i}Y${i}S500`);
    let end: unknown = "pending";
    const progress: number[] = [];
    link.startJob(lines, (acked) => progress.push(acked), (e) => (end = e));
    await wait(0);
    expect(peak).toBeLessThanOrEqual(RX_BUFFER);
    expect(sizes.length).toBeLessThan(40);
    // La machine acquitte ligne à ligne : le reste part au fur et à mesure.
    for (let i = 0; i < 40; i++) {
      pending -= sizes[i];
      pipe.emit(enc("ok\r\n"));
      await wait(0);
      expect(pending).toBeLessThanOrEqual(RX_BUFFER);
    }
    expect(end).toBeNull();
    expect(progress[progress.length - 1]).toBe(40);
    expect(pipe.writes.map(dec).join("")).toBe(lines.join("\n") + "\n");
  });

  it("arrête d'envoyer à la première erreur et donne la ligne", async () => {
    const pipe = new FakePipe();
    let n = 0;
    pipe.respond = () => enc(++n === 3 ? "error:20\r\n" : "ok\r\n");
    const link = new GrblLink(pipe, () => undefined, 0);
    let end: unknown = "pending";
    link.startJob(Array.from({ length: 200 }, () => "G1X1"), () => undefined, (e) => (end = e));
    await wait(20);
    expect(end).toMatchObject({ line: 3, message: "commande G-code inconnue" });
    expect(pipe.writes.length).toBeLessThan(200);
    expect(link.busy).toBe(false);
  });

  it("fait passer une commande avant la suite du programme et oublie tout à la remise à zéro", async () => {
    const pipe = new FakePipe();
    const seen: GrblMessage[] = [];
    const link = new GrblLink(pipe, (m) => seen.push(m), 0);
    const ack = link.command("$I");
    expect(dec(pipe.writes[0])).toBe("$I\n");
    pipe.emit(enc("[VER:1.1h:]\r\nok\r\n"));
    expect(await ack).toEqual({ ok: true });
    expect(seen.map((m) => m.type)).toEqual(["info", "ok"]);

    const lost = link.command("G1X1");
    pipe.emit(enc("Grbl 1.1h ['$' for help]\r\n"));
    expect(await lost).toMatchObject({ ok: false, aborted: true });
    pipe.pipeReady = false;
    expect(await link.command("G1X1")).toMatchObject({ ok: false, aborted: true });
  });
});

describe("sonic-grbl", () => {
  it("lit version, réglages et position à la connexion", async () => {
    const sim = simulator();
    const el = await mountGrbl(sim);
    const s = el.getState();
    expect(s).toMatchObject({ status: "ready", connected: true, firmware: "1.1h.20190825", maxS: 1000, laserMode: true, homing: false, area: { x: 410, y: 400 } });
    expect(sim.lines.slice(0, 2)).toEqual(["$I", "$$"]);
    await wait(300);
    expect(el.getState().machineState).toBe("Idle");
    expect(el.getState().mpos).toEqual({ x: 10, y: 20, z: 0 });
    expect(el.getState().pos).toEqual({ x: 0, y: 15, z: 0 });
    expect(el.getState().console).toContain("> $I");
  });

  it("signale une machine muette", async () => {
    const sim = simulator();
    sim.silent = true;
    document.body.insertAdjacentHTML("beforeend", "<sonic-grbl id=\"g\" transport=\"#rien\"></sonic-grbl>");
    await wait(150);
    expect((document.querySelector("#g") as SonicGrbl).getState().error).toContain("transport introuvable");
  });

  it("envoie une tâche, remplace M3 et termine par M5 et la temporisation de fin", async () => {
    const sim = simulator();
    const el = await mountGrbl(sim);
    await wait(150);
    const events: string[] = [];
    for (const name of ["sonic-grbl-start", "sonic-grbl-done", "sonic-grbl-error"]) el.addEventListener(name, () => events.push(name));
    sim.lines.length = 0;
    expect(await el.run("run", { gcode: "G90\nM3 S0\nG0 X0 Y0\nG1 X10 Y0 S800 F600\nG1 X10 Y10\nM5" })).toBe(true);
    await wait(50);
    expect(sim.lines).toEqual(["G90", "M4S0", "G0X0Y0", "G1X10Y0S800F600", "G1X10Y10", "M5", "M5", "G4P0.01"]);
    expect(events).toEqual(["sonic-grbl-start", "sonic-grbl-done"]);
    expect(el.getState()).toMatchObject({ job: null, jobs: 1, error: null });
    expect(el.getState().issues[0]).toContain("M3 remplacé");
  });

  it("refuse une tâche en mode laser désactivé, hors zone, ou machine pas au repos", async () => {
    const off = simulator({ 30: 1000, 32: 0, 130: 410, 131: 400 });
    const a = await mountGrbl(off);
    await wait(150);
    expect(await a.run("run", { gcode: "G1X1S10F100" })).toBe(false);
    expect(a.getState().error).toContain("$32=0");
    document.body.innerHTML = "";

    const sim = simulator();
    const b = await mountGrbl(sim, 'machine="atomstack-a5-pro"');
    await wait(150);
    expect(await b.run("run", { gcode: "G90\nG1X500Y10S10F100" })).toBe(false);
    expect(b.getState().error).toContain("hors de la zone");
    expect(await b.run("run", { gcode: "G1X1\n$RST=*" })).toBe(false);
    expect(b.getState().error).toContain("ligne 2");
    sim.state = "Alarm";
    await wait(300);
    expect(b.getState().alarm).not.toBeNull();
    expect(await b.run("run", { gcode: "G1X1S10F100" })).toBe(false);
    expect(b.getState().error).toContain("pas au repos");
    expect(sim.lines.filter((l) => l.startsWith("G1"))).toEqual([]);
  });

  it("plafonne la puissance avec max-power", async () => {
    const sim = simulator();
    const el = await mountGrbl(sim, 'max-power="30"');
    await wait(150);
    sim.lines.length = 0;
    await el.run("run", { gcode: "M4S1000\nG1X5S900F500\nG1X6S200" });
    await wait(50);
    expect(sim.lines.slice(0, 3)).toEqual(["M4S300", "G1X5S300F500", "G1X6S200"]);
  });

  it("arrête proprement à la première erreur de la machine", async () => {
    const sim = simulator();
    sim.failOn = /^G1X3/;
    const el = await mountGrbl(sim);
    await wait(150);
    let error: unknown = null;
    el.addEventListener("sonic-grbl-error", (e) => (error = (e as CustomEvent).detail));
    await el.run("run", { gcode: "G1X1F100S10\nG1X2\nG1X3\nG1X4" });
    await wait(80);
    expect(error).toMatchObject({ line: 3 });
    expect(el.getState().error).toContain("ligne 3");
    expect(el.getState().job).toBeNull();
    expect(sim.realtime).toContain(RT.HOLD);
    expect(sim.realtime).toContain(RT.RESET);
    expect(el.getState().jobs).toBe(0);
  });

  it("met en pause, reprend et arrête", async () => {
    const sim = simulator();
    const pipe = sim.pipe;
    const respond = pipe.respond;
    // La machine n'acquitte plus les mouvements : la tâche reste en cours.
    pipe.respond = (data) => (/^G1/.test(dec(data)) ? null : respond(data));
    const el = await mountGrbl(sim);
    await wait(150);
    expect(await el.run("run", { gcode: "G1X1F100S10\nG1X2\nG1X3" })).toBe(true);
    await wait(30);
    expect(el.getState().job).toMatchObject({ running: true, kind: "job" });
    expect(await el.run("jog", { x: 5 })).toBe(false);
    expect(await el.run("hold")).toBe(true);
    await wait(300);
    expect(el.getState().job?.paused).toBe(true);
    expect(await el.run("resume")).toBe(true);
    let stopped = false;
    el.addEventListener("sonic-grbl-stop", () => (stopped = true));
    expect(await el.run("stop")).toBe(true);
    expect(stopped).toBe(true);
    expect(el.getState().job).toBeNull();
    expect(sim.realtime.slice(-1)).toEqual([RT.RESET]);
  });

  it("déplace, pose l'origine, cadre et garde la console", async () => {
    const sim = simulator();
    const el = await mountGrbl(sim);
    await wait(150);
    sim.lines.length = 0;
    expect(await el.run("jog", { x: 10, y: -5.5, feed: 99999 })).toBe(true);
    expect(await el.run("goto", { x: 0, y: 0 })).toBe(true);
    expect(await el.run("jog", {})).toBe(false);
    expect(await el.run("setOrigin")).toBe(true);
    expect(await el.run("home")).toBe(false);
    expect(el.getState().error).toContain("prise d'origine");
    expect(await el.run("send", { line: "m3 s10" })).toBe(true);
    expect(await el.run("send", { line: "$30=255" })).toBe(false);
    expect(sim.lines).toEqual(["$J=G91G21X10Y-5.5F6000", "$J=G90G21X0Y0F2000", "G92X0Y0", "M4S10"]);

    sim.lines.length = 0;
    expect(await el.run("frame", { gcode: "G90\nG0X5Y5\nG1X25Y5S500F600\nG1X25Y15", power: 50 })).toBe(true);
    await wait(50);
    expect(sim.lines).toEqual(["G90", "G21", "M5", "G0X5Y5", "M4S50", "G1F3000", "G1X25Y5", "G1X25Y15", "G1X5Y15", "G1X5Y5", "M5", "G4P0.01"]);
    expect(el.getState().jobs).toBe(0);
    expect(el.getState().console.some((l) => l.startsWith("> $J="))).toBe(true);
  });

  it("essai à vide : mêmes mouvements, faisceau coupé, vitesse accélérée ; ne compte pas comme gravure", async () => {
    const sim = simulator();
    const el = await mountGrbl(sim, 'laser-mode=""');
    await wait(150);
    sim.lines.length = 0;
    expect(await el.run("dryRun", { gcode: "G90\nM4 S0\nG0 X0 Y0\nG1 X10 Y0 S800 F600\nG1 X10 Y10", speed: 2 })).toBe(true);
    await wait(50);
    expect(sim.lines).toEqual(["M5", "G90", "M5", "G0X0Y0", "G1X10Y0F1200", "G1X10Y10", "M5", "G4P0.01"]);
    expect(sim.lines.some((l) => /M[34]|S[1-9]/.test(l))).toBe(false);
    expect(el.getState()).toMatchObject({ job: null, jobs: 0, error: null });
  });

  it("note la ligne d'arrêt et reprend à une ligne avec l'état modal rétabli", async () => {
    const sim = simulator();
    const pipe = sim.pipe;
    const respond = pipe.respond;
    let ackUntil = 3;
    let seen = 0;
    pipe.respond = (data) => {
      const t = dec(data);
      if (/^G1X/.test(t)) {
        seen++;
        if (seen > ackUntil) return null;
      }
      return respond(data);
    };
    const el = await mountGrbl(sim);
    await wait(150);
    const prog = ["G90", "M4", "G0X0Y0", "G1X1Y0S300F500"];
    for (let i = 2; i <= 40; i++) prog.push(`G1X${i}Y0`);
    expect(await el.run("run", { gcode: prog.join("\n") })).toBe(true);
    await wait(50);
    expect(el.getState().job).toMatchObject({ kind: "job", from: 0, total: prog.length });
    expect(await el.run("stop")).toBe(true);
    const stop = el.getState().lastStop;
    expect(stop).toMatchObject({ kind: "job", total: prog.length, reason: "arrêt demandé" });
    expect(stop!.line).toBeGreaterThan(3);
    expect(stop!.resumeAt).toBe(Math.max(0, stop!.line - 16));

    ackUntil = 1e9;
    sim.lines.length = 0;
    expect(await el.run("run", { gcode: prog.join("\n"), from: 30 })).toBe(true);
    await wait(50);
    expect(sim.lines.slice(0, 9)).toEqual(["G21", "G90", "M5", "G0X27Y0", "F500", "S300", "M4", "G1", prog[30]]);
    expect(el.getState()).toMatchObject({ job: null, lastStop: null, jobs: 1 });
    expect(await el.run("run", { gcode: prog.join("\n"), from: 999 })).toBe(false);
    expect(el.getState().error).toContain("au-delà de la fin");
  });

  it("pointeur : faisceau faible sur place, plafonné, éteint par un déplacement ou tout seul", async () => {
    const sim = simulator();
    const el = await mountGrbl(sim);
    await wait(150);
    sim.lines.length = 0;
    expect(await el.run("pointer", { on: true, power: 9, seconds: 1 })).toBe(true);
    expect(sim.lines).toEqual(["M3S20", "G1F1000"]);
    expect(el.getState().pointer).toBe(2);
    expect(await el.run("jog", { x: 1 })).toBe(true);
    expect(sim.lines.slice(2, 3)).toEqual(["M5"]);
    expect(el.getState().pointer).toBeNull();
    sim.lines.length = 0;
    expect(await el.run("pointer", { on: true, seconds: 1 })).toBe(true);
    await wait(1200);
    expect(sim.lines).toEqual(["M3S10", "G1F1000", "M5"]);
    expect(el.getState().pointer).toBeNull();
  });

  it("cadre le contour réel du dessin (enveloppe) et plusieurs tours", async () => {
    const sim = simulator();
    const el = await mountGrbl(sim);
    await wait(150);
    sim.lines.length = 0;
    expect(await el.run("frame", { gcode: "G90\nG0X0Y0\nM4\nG1X10Y0S500F600\nG1X5Y8\nG1X0Y0\nG0X50Y50", shape: "hull", loops: 2 })).toBe(true);
    await wait(50);
    expect(sim.lines).toEqual(["G90", "G21", "M5", "G0X0Y0", "M5", "G1F3000", "G1X10Y0", "G1X5Y8", "G1X0Y0", "G1X10Y0", "G1X5Y8", "G1X0Y0", "M5", "G4P0.01"]);
  });

  it("arrête la machine si le composant est retiré pendant une tâche", async () => {
    const sim = simulator();
    const respond = sim.pipe.respond;
    sim.pipe.respond = (data) => (/^G1/.test(dec(data)) ? null : respond(data));
    const el = await mountGrbl(sim);
    await wait(150);
    await el.run("run", { gcode: "G1X1F100S10\nG1X2" });
    await wait(20);
    sim.realtime.length = 0;
    el.remove();
    expect(sim.realtime).toEqual([RT.HOLD, RT.RESET]);
  });
});

describe("parcours", () => {
  it("hachure une surface en serpentin, trous compris", () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: [number, number][] = [[4, 4], [6, 4], [6, 6], [4, 6]];
    const full = hatch([square], 1);
    expect(full.length).toBe(10);
    expect(full[0]).toEqual([[0, 0.5], [10, 0.5]]);
    expect(full[1]).toEqual([[10, 1.5], [0, 1.5]]);
    const holed = hatch([square, hole], 1);
    expect(holed.length).toBe(12);
    expect(holed.filter(([a, b]) => Math.abs(b[0] - a[0]) < 5).length).toBe(4);
  });

  it("passe les contours intérieurs d'abord", () => {
    const ring = (x: number, y: number, s: number) => ({ pts: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]] as [number, number][], closed: true });
    const outer = ring(0, 0, 100), inner = ring(40, 40, 10), far = { pts: [[200, 0], [210, 0]] as [number, number][], closed: false };
    expect(orderPaths([outer, far, inner])[0]).toBe(inner);
  });

  it("lit les couleurs et borne les réglages", () => {
    expect(hexColor("#F00")).toBe("#ff0000");
    expect(hexColor("rouge")).toBeNull();
    const base = { mode: "auto" as const, power: 20, speed: 1500, passes: 1, interval: 0.1, kerf: 0 };
    expect(cleanOp({ color: "FF0000", mode: "line", power: 150, passes: 2.4, speed: "300" }, base)).toEqual({ color: "#ff0000", mode: "line", power: 100, speed: 300, passes: 2, interval: 0.1, kerf: 0 });
  });

  it("change un SVG en programme : gravure puis découpe, à la taille demandée, axe Y retourné", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
      <rect x="0" y="0" width="100" height="50" fill="#ffffff"/>
      <rect x="10" y="10" width="20" height="10" fill="#000000"/>
      <path d="M0 0 H100 V50 H0 Z" fill="none" stroke="#ff0000"/>
      <text x="5" y="5">a</text>
    </svg>`;
    const res = svgToGcode(svg, { ...TOOLPATH_DEFAULTS, widthMm: 50, interval: 1, ops: [{ color: "#ff0000", mode: "line", power: 90, speed: 300, passes: 2, interval: 0.1, kerf: 0 }] });
    expect(res.error).toBeNull();
    expect(res.sizeMm).toEqual({ w: 50, h: 25 });
    expect(res.skipped).toEqual({ text: 1 });
    const lines = res.lines;
    expect(lines.slice(0, 4)).toEqual(["G90", "G21", "M5", "M4S0"]);
    expect(lines.slice(-2)).toEqual(["M5", "G0X0Y0"]);
    const firstCut = lines.findIndex((l) => l.includes("S900"));
    const lastFill = lines.map((l) => l.includes("S200")).lastIndexOf(true);
    expect(lastFill).toBeGreaterThan(0);
    expect(firstCut).toBeGreaterThan(lastFill);
    // Hachures du rectangle noir : x de 5 à 15 mm, y de 15 à 20 mm (le haut du dessin est au fond).
    const fill = analyzeGcode(lines.slice(0, firstCut - 1));
    expect(fill.bbox).toEqual({ x: 5, y: 15.5, w: 10, h: 4 });
    expect(lines).toContain("G1X15Y15.5S200F1500");
    // Découpe : deux passes du cadre.
    expect(lines.filter((l) => l.includes("S900")).length).toBe(2);
    const stats = analyzeGcode(lines);
    expect(stats.bbox).toEqual({ x: 0, y: 0, w: 50, h: 25 });
    expect(stats.maxS).toBe(900);
    expect(stats.hasM3).toBe(false);
  });

  it("respecte la taille réelle d'un SVG en millimètres et le mode stylo", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 400 200"><path d="M0 0L400 200" fill="none" stroke="#000"/></svg>';
    const res = svgToGcode(svg, { ...TOOLPATH_DEFAULTS, tool: "pen", returnHome: false });
    expect(res.sizeMm).toEqual({ w: 40, h: 20 });
    expect(res.lines).toEqual(["G90", "G21", "M5", "G0X0Y20", "M3S1000", "G4P0.15", "G1X40Y0F1500", "M5", "G4P0.15", "M5"]);
    expect(svgToGcode("<svg xmlns='http://www.w3.org/2000/svg'/>", TOOLPATH_DEFAULTS).error).toContain("aucune forme");
    expect(svgToGcode("pas du svg", TOOLPATH_DEFAULTS).error).not.toBeNull();
  });

  it("grave une image par balayage : lignes blanches sautées, serpentin, niveaux de gris", () => {
    // 4 × 3 : ligne 0 noire au milieu, ligne 1 blanche, ligne 2 noire partout.
    const gray = Float32Array.from([255, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
    const s = { widthMm: 4, xMm: 0, yMm: 0, dither: "threshold" as const, threshold: 128, power: 50, minPower: 0, speed: 1000, maxS: 1000, returnHome: true };
    expect(rasterToGcode(gray, 4, 3, s)).toEqual(["G90", "G21", "M5", "M4S0", "G0X1Y2.5", "G1X3S500F1000", "G0X4Y0.5", "G1X0S500F1000", "M5", "G0X0Y0"]);
    const shades = rasterToGcode(Float32Array.from([0, 0, 128, 255]), 4, 1, { ...s, dither: "gray", power: 100 });
    expect(shades).toEqual(["G90", "G21", "M5", "M4S0", "G0X0Y0.5", "G1X2S1000F1000", "G1X3S484", "M5", "G0X0Y0"]);
    expect(rasterToGcode(Float32Array.from([255, 255]), 2, 1, s)).toEqual([]);
  });
});

describe("sonic-gcode", () => {
  it("construit le programme d'un SVG donné en texte et le fournit à sonic-grbl", async () => {
    const { set, get } = await import("@supersoniks/concorde/core/utils/PublisherProxy");
    set("dessinSvg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0H10V10H0Z" fill="none" stroke="#000"/></svg>');
    set("reglages", { build: 0 });
    document.body.insertAdjacentHTML("beforeend", '<sonic-gcode id="prog" svg-from="dessinSvg" width-mm="30" power="80" speed="400" control="reglages"></sonic-gcode>');
    const el = document.querySelector("sonic-gcode") as SonicGcode;
    await el.updateComplete;
    expect(el.getGcode()).toBeNull();
    expect(await el.run("build")).toBe(true);
    expect(el.getGcode()).toEqual(["G90", "G21", "M5", "M4S0", "G0X0Y30", "G1X30Y30S800F400", "G1X30Y0", "G1X0Y0", "G1X0Y30", "M5", "G0X0Y0"]);
    expect(el.getState()).toMatchObject({ status: "ready", ready: true, kind: "vector", lines: 11, bbox: { x: 0, y: 0, w: 30, h: 30 }, sizeMm: { w: 30, h: 30 }, burnMm: 120 });
    expect((get("progState") as { seq: number }).seq).toBe(1);

    // Réglage en direct puis reconstruction par compteur.
    set("reglages", { build: 1, power: 10, widthMm: 10 });
    await wait(40);
    expect(el.getGcode()?.[5]).toBe("G1X10Y10S100F400");
    expect(el.gcodeSeq).toBe(2);

    const sim = simulator();
    const laser = await mountGrbl(sim, 'source="#prog"');
    await wait(150);
    sim.lines.length = 0;
    expect(await laser.run("run")).toBe(true);
    await wait(50);
    expect(sim.lines.slice(0, 6)).toEqual(["G90", "G21", "M5", "M4S0", "G0X0Y10", "G1X10Y10S100F400"]);
    expect(laser.getState().jobs).toBe(1);
  });

  it("ne garde jamais un ancien programme quand la source change ou que la construction échoue", async () => {
    const { set } = await import("@supersoniks/concorde/core/utils/PublisherProxy");
    set("svgA", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0H10V10Z" fill="none" stroke="#000"/></svg>');
    document.body.insertAdjacentHTML("beforeend", '<sonic-gcode id="prog2" svg-from="svgA"></sonic-gcode>');
    const el = document.getElementById("prog2") as unknown as SonicGcode;
    await el.updateComplete;
    expect(await el.run("build")).toBe(true);
    expect(el.getGcode()).not.toBeNull();
    // Le fichier disparaît : plus de programme, même avant toute reconstruction.
    set("svgA", null);
    expect(el.getGcode()).toBeNull();
    expect(el.getState().ready).toBe(false);
    set("svgA", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0H10V10Z" fill="none" stroke="#000"/></svg>');
    expect(await el.run("build")).toBe(true);
    // Nouvelle source sans image : l'ancien programme est retiré.
    el.source = "#absente";
    el.input = "image";
    await el.updateComplete;
    expect(el.getGcode()).toBeNull();
    expect(await el.run("build")).toBe(false);
    expect(el.getState()).toMatchObject({ ready: false, lines: 0 });
  });

  it("dit quand il n'y a rien à tracer", async () => {
    document.body.insertAdjacentHTML("beforeend", '<sonic-gcode id="vide"></sonic-gcode>');
    const el = document.querySelector("sonic-gcode") as SonicGcode;
    await el.updateComplete;
    expect(await el.run("build")).toBe(false);
    expect(el.getState().error).toContain("aucune source");
    expect(await el.run("download")).toBe(false);
  });
});

describe("tâches (essai, reprise, cadrage)", () => {
  it("lit l'état modal avant une ligne", () => {
    const st = modalAt(["G21", "G90", "M4", "G0X5Y5", "G1X10Y5S400F900", "G91", "G1X2"], 7);
    expect(st).toMatchObject({ abs: false, motion: 1, feed: 900, s: 400, laser: "M4", x: 12, y: 5 });
    expect(modalAt(["G1X1"], 0)).toMatchObject({ x: 0, y: 0, laser: "M5" });
  });

  it("refuse une reprise en relatif ou hors programme, laisse le programme entier à la ligne 0", () => {
    expect(resumeLines(["G91", "G1X1", "G1X2"], 2).error).toContain("relatives");
    expect(resumeLines(["G1X1"], 5).error).toContain("au-delà");
    expect(resumeLines(["G1X1", "G1X2"], 0)).toEqual({ lines: ["G1X1", "G1X2"], preamble: 0, error: null });
    expect(resumeHint(10)).toBe(0);
    expect(resumeHint(100)).toBe(84);
  });

  it("essai à vide : retire M3/M4 et S, borne l'accélération à 4× et 6000 mm/min", () => {
    expect(dryRunLines(["M3S500", "G1X1F2000S900", "G1X2"], 10)).toEqual(["M5", "M5", "G1X1F6000", "G1X2"]);
    expect(dryRunLines(["G1X1F100"], 1)).toEqual(["M5", "G1X1F100"]);
  });

  it("points brûlés et enveloppe convexe", () => {
    const pts = burnPoints(["G90", "M4", "G0X0Y0", "G1X10Y0S100F500", "G1X10Y10", "G1X5Y5", "G0X100Y100"]);
    expect(pts).toContainEqual([10, 10]);
    expect(pts).not.toContainEqual([100, 100]);
    expect(convexHull(pts)).toEqual([[0, 0], [10, 0], [10, 10]]);
    expect(frameLines(["G0X1Y1"], { feed: 1000, sValue: 0 })).toBeNull();
  });
});
