import { afterEach, describe, expect, it } from "vitest";
import "./index";
import {
  CAT, CAT_WIDTH_PX, FakePipe, PHOMEMO_CHUNK, PrinterLink, catFrame, catJob, catLine, crc8, createProtocol, getProfile, groupFrames, modelFromName,
  parseCatFrames, parseCatState, phomemoJob, phomemoProtocol, phomemoVariant, reverseBits, toHex,
} from "./index";
import { chunks } from "../../shared/pipe/queue";
import { protocolFromProfile } from "./printer/models";

afterEach(() => {
  document.body.innerHTML = "";
});

const job = (rows: number, bytesPerRow: number, fill = 0xff) => ({ data: new Uint8Array(rows * bytesPerRow).fill(fill), bytesPerRow, rows, density: 1, paper: "gap" as const });

describe("imprimantes « chat »", () => {
  it("CRC-8 (polynôme 0x07) : valeurs des trames publiées", () => {
    expect(crc8([])).toBe(0);
    expect(crc8([0x01])).toBe(0x07);
    expect(crc8([0x32])).toBe(0x9e);
    expect(crc8([0x30, 0x00])).toBe(0xf9);
    expect(crc8([0x10])).toBe(0x70);
  });

  it("trames : cadre, longueur petit-boutiste, CRC, fin FF", () => {
    expect(toHex(catFrame(CAT.quality, [0x32]))).toBe("51 78 a4 00 01 00 32 9e ff");
    expect(toHex(catFrame(CAT.feed, [0x30, 0x00]))).toBe("51 78 a1 00 02 00 30 00 f9 ff");
    expect(toHex(catFrame(CAT.lattice, [0xaa, 0x55, 0x17, 0x38, 0x44, 0x5f, 0x5f, 0x5f, 0x44, 0x38, 0x2c]))).toBe(
      "51 78 a6 00 0b 00 aa 55 17 38 44 5f 5f 5f 44 38 2c a1 ff",
    );
    expect(catFrame(CAT.line, new Uint8Array(300)).subarray(4, 6)).toEqual(Uint8Array.from([0x2c, 0x01]));
  });

  it("ligne : bits inversés par octet (point de gauche en poids faible), 48 octets complétés", () => {
    expect(reverseBits(0x80)).toBe(0x01);
    expect(reverseBits(0x01)).toBe(0x80);
    expect(reverseBits(0xc4)).toBe(0x23);
    const f = catLine([0x80, 0xf0]);
    expect(f.length).toBe(8 + 48);
    expect(Array.from(f.subarray(0, 9))).toEqual([0x51, 0x78, 0xa2, 0x00, 0x30, 0x00, 0x01, 0x0f, 0x00]);
    expect(f[6 + 48]).toBe(crc8(f.subarray(6, 6 + 48)));
    expect(f[f.length - 1]).toBe(0xff);
  });

  it("lecture des notifications : trames valides, contrôle de flux, octet d'état", () => {
    const pause = [0x51, 0x78, 0xae, 0x01, 0x01, 0x00, 0x10, 0x70, 0xff];
    const frames = parseCatFrames([0x00, ...pause, 0x51, 0x78, 0xa3, 0x01, 0x01, 0x00, 0x03, 0x00, 0xff]);
    // La deuxième trame a un CRC faux : écartée.
    expect(frames).toEqual([{ cmd: CAT.flow, data: Uint8Array.from([0x10]) }]);
    expect(parseCatState(0x03)).toMatchObject({ paper: "out", cover: "open", overheated: false });
  });

  it("tâche : préparation, une trame a2 par ligne, avance et fin de lattice", () => {
    const { head, lines, tail } = catJob(job(3, 48));
    expect(head.map((f) => f[2])).toEqual([CAT.state, CAT.quality, CAT.lattice, CAT.energy, CAT.mode, CAT.speed]);
    expect(lines.length).toBe(3);
    expect(lines.every((l) => l[2] === CAT.line && l.length === 56)).toBe(true);
    expect(tail.map((f) => f[2])).toEqual([CAT.speed, CAT.feed, CAT.lattice, CAT.state]);
    expect(toHex(tail[2].subarray(6, 17))).toBe("aa 55 17 00 00 00 00 00 00 00 17");
  });

  it("découpage : trames regroupées sans être coupées, puis morceaux du transport", () => {
    const frames = Array.from({ length: 10 }, () => catLine(new Uint8Array(48)));
    const groups = groupFrames(frames, 4 * 56);
    expect(groups.map((g) => g.length)).toEqual([224, 224, 112]);
    expect(chunks(groups[0], 20).length).toBe(12);
  });

  it("impression sur un faux canal : ordre des trames, pause demandée par l'imprimante", async () => {
    const pipe = new FakePipe("GB02", (data) => (data[2] === CAT.state ? catFrame(CAT.state, [0]).map((b, i) => (i === 3 ? 1 : b)) : null));
    const link = new PrinterLink(pipe, 0);
    const proto = createProtocol("cat")!;
    expect(proto.id).toBe("cat");
    const info = await proto.info(link);
    expect(info.status).toMatchObject({ paper: "ok", cover: "closed" });
    pipe.writes.length = 0;
    let paused = false;
    pipe.respond = (data) => {
      if (data[2] === CAT.line && !paused) {
        paused = true;
        setTimeout(() => pipe.emit(Uint8Array.from([0x51, 0x78, 0xae, 0x01, 0x01, 0x00, 0x00, 0x00, 0xff])), 30);
        return [0x51, 0x78, 0xae, 0x01, 0x01, 0x00, 0x10, 0x70, 0xff];
      }
      return null;
    };
    const progress: number[] = [];
    expect(await proto.print(link, job(10, 48), (p) => progress.push(p))).toBeNull();
    const cmds = pipe.writes.flatMap((w) => parseCatFrames(w).map((f) => f.cmd));
    expect(cmds.slice(0, 7)).toEqual([CAT.state, CAT.state, CAT.quality, CAT.lattice, CAT.energy, CAT.mode, CAT.speed]);
    expect(cmds.filter((c) => c === CAT.line).length).toBe(10);
    expect(cmds.slice(-4)).toEqual([CAT.speed, CAT.feed, CAT.lattice, CAT.state]);
    expect(progress[progress.length - 1]).toBe(1);
    expect(await proto.print(link, job(2, CAT_WIDTH_PX / 8 + 1), () => undefined)).toMatch(/trop large/);
  });

  it("modèles et profil : noms reconnus, tête de 384 points", () => {
    expect(modelFromName("GB03-1234")).toMatchObject({ protocol: "cat", widthPx: 384 });
    expect(modelFromName("MX10")).toMatchObject({ protocol: "cat" });
    expect(protocolFromProfile("cat")).toBe("cat");
    expect(getProfile("cat")?.channels).toEqual({ tx: "ae30/ae01", rx: "ae30/ae02" });
  });
});

describe("Phomemo", () => {
  it("variante d'après le nom, modèles", () => {
    expect(phomemoVariant("M110-ABCD")).toBe("m110");
    expect(phomemoVariant("D30")).toBe("d30");
    expect(phomemoVariant("M02S")).toBe("m02");
    expect(phomemoVariant("T02")).toBe("m02");
    expect(modelFromName("D30")).toMatchObject({ protocol: "phomemo-d30", widthPx: 96 });
    expect(modelFromName("M110")).toMatchObject({ protocol: "phomemo-m110", widthPx: 384 });
    expect(createProtocol("phomemo-m110")?.id).toBe("phomemo-m110");
    expect(createProtocol("phomemo-x")).toBeNull();
    expect(protocolFromProfile("phomemo")).toBe("phomemo");
    expect(getProfile("phomemo")).toMatchObject({ channels: { tx: "ff00/ff02", rx: "ff00/ff03" }, chunkSize: 128 });
  });

  it("M02 : initialisation, raster GS v 0 par bandes de 255 lignes, avance ESC d", () => {
    const writes = phomemoJob("m02", job(300, 48)).map((w) => Uint8Array.from(w));
    expect(toHex(writes[0])).toBe("1b 40 1b 61 01 1f 11 02 04");
    expect(toHex(writes[1].subarray(0, 8))).toBe("1d 76 30 00 30 00 ff 00");
    expect(writes[1].length).toBe(8 + 255 * 48);
    expect(toHex(writes[2].subarray(0, 8))).toBe("1d 76 30 00 30 00 2d 00");
    expect(toHex(writes[3].subarray(0, 6))).toBe("1b 64 02 1b 64 02");
  });

  it("M110 : réglages constructeur, raster en une bande, fin 1F F0", () => {
    const writes = phomemoJob("m110", { ...job(320, 40), density: 2, paper: "continuous" }).map((w) => Uint8Array.from(w));
    expect(toHex(writes[0])).toBe("1b 4e 0d 05 1b 4e 04 0e 1f 11 0b");
    expect(toHex(writes[1].subarray(0, 8))).toBe("1d 76 30 00 28 00 40 01");
    expect(toHex(writes[2])).toBe("1f f0 05 00 1f f0 03 00");
  });

  it("D30 : préambule puis raster de 12 octets par ligne", () => {
    const writes = phomemoJob("d30", job(320, 12)).map((w) => Uint8Array.from(w));
    expect(toHex(writes[0])).toBe("1f 11 24 00 1b 40");
    expect(toHex(writes[1].subarray(0, 8))).toBe("1d 76 30 00 0c 00 40 01");
    expect(writes.length).toBe(2);
  });

  it("impression : morceaux de 128 octets, variante choisie au nom", async () => {
    const pipe = new FakePipe("M110-1234");
    const link = new PrinterLink(pipe, 0);
    expect(await phomemoProtocol().print(link, job(40, 40), () => undefined)).toBeNull();
    expect(pipe.options.every((o) => o?.chunkSize === PHOMEMO_CHUNK)).toBe(true);
    expect(toHex(pipe.writes[0].subarray(0, 4))).toBe("1b 4e 0d 05");
    pipe.pipeReady = false;
    expect(await phomemoProtocol("m02").print(link, job(4, 48), () => undefined)).toBe("imprimante déconnectée");
  });
});
