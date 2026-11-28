import { describe, expect, it } from "vitest";
import { deflateSync, gzipSync } from "node:zlib";
import { readSvgShapes, svgToGcode, TOOLPATH_DEFAULTS } from "../toolpath";
import { aciColor, detectFormat, importBytes, readDxf, readGcodeText, readHpgl, readLightburn, readPostScript, writeSvg } from "./index";
import { lzw } from "./pdf";
import { readTiff } from "./tiff";

const enc = (s: string) => new TextEncoder().encode(s);
const latin = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255));

const dxf = (entities: string, header = "  9\n$INSUNITS\n 70\n4\n") =>
  `  0\nSECTION\n  2\nHEADER\n${header}  0\nENDSEC\n  0\nSECTION\n  2\nTABLES\n  0\nLAYER\n  2\nDECOUPE\n 62\n1\n  0\nLAYER\n  2\nCACHE\n 62\n-3\n  0\nENDSEC\n` +
  `  0\nSECTION\n  2\nBLOCKS\n  0\nBLOCK\n  2\nCARRE\n 10\n0\n 20\n0\n  0\nLWPOLYLINE\n  8\n0\n 90\n4\n 70\n1\n 10\n0\n 20\n0\n 10\n10\n 20\n0\n 10\n10\n 20\n10\n 10\n0\n 20\n10\n  0\nENDBLK\n  0\nENDSEC\n` +
  `  0\nSECTION\n  2\nENTITIES\n${entities}  0\nENDSEC\n  0\nEOF\n`;

/** Emprise (mm) d'un SVG produit, lue par le même lecteur que sonic-gcode. */
const sizeOf = (svg: string) => {
  const m = /width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg)!;
  return [Number(m[1]), Number(m[2])];
};

describe("détection du format", () => {
  it("reconnaît les signatures avant l'extension", () => {
    expect(detectFormat("plan.ai", "", latin("%PDF-1.5\n"))).toBe("ai");
    expect(detectFormat("x.bin", "", latin("%PDF-1.4\n"))).toBe("pdf");
    expect(detectFormat("logo.eps", "", latin("%!PS-Adobe-3.0 EPSF-3.0\n"))).toBe("eps");
    expect(detectFormat("a", "", Uint8Array.from([0xc5, 0xd0, 0xd3, 0xc6]))).toBe("eps");
    expect(detectFormat("a.dxf", "", latin("  0\nSECTION\n  2\nHEADER\n"))).toBe("dxf");
    expect(detectFormat("sans-extension", "", latin("  0\nSECTION\n  2\nENTITIES\n"))).toBe("dxf");
    expect(detectFormat("p.lbrn2", "", latin('<?xml version="1.0"?>\n<LightBurnProject AppVersion="1.4">'))).toBe("lightburn");
    expect(detectFormat("t.plt", "", latin("IN;SP1;PU0,0;PD100,0;"))).toBe("hpgl");
    expect(detectFormat("x", "", latin("IN;SP1;PU0,0;PD100,0;"))).toBe("hpgl");
    expect(detectFormat("job.nc", "", latin("G21\nG90\nG0 X1 Y1\n"))).toBe("gcode");
    expect(detectFormat("x", "", latin("; LightBurn\nG21\nG0 X1\nG1 X2 S100\n"))).toBe("gcode");
    expect(detectFormat("x.tif", "", Uint8Array.from([0x49, 0x49, 42, 0]))).toBe("tiff");
    expect(detectFormat("x.svgz", "", Uint8Array.from([0x1f, 0x8b]))).toBe("svg");
    expect(detectFormat("a.svg", "", latin('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">'))).toBe("svg");
    expect(detectFormat("a.png", "", Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe("image");
    expect(detectFormat("a.cdr", "", latin("RIFF....CDR"))).toBeNull();
  });

  it("donne un conseil d'export pour les formats fermés", async () => {
    await expect(importBytes(latin("RIFFxxxxCDRv"), { name: "logo.cdr" })).rejects.toThrow(/CorelDraw/);
    await expect(importBytes(latin("xx"), { name: "piece.dwg" })).rejects.toThrow(/DXF/);
  });
});

describe("DXF", () => {
  it("lit lignes, cercles, arcs, polylignes à renflement, calques et blocs", () => {
    const r = readDxf(dxf(
      "  0\nLINE\n  8\nDECOUPE\n 10\n0\n 20\n0\n 11\n100\n 21\n0\n" +
      "  0\nCIRCLE\n  8\n0\n 62\n5\n 10\n50\n 20\n50\n 40\n10\n" +
      "  0\nARC\n  8\n0\n 10\n0\n 20\n0\n 40\n20\n 50\n0\n 51\n90\n" +
      "  0\nLWPOLYLINE\n  8\n0\n 90\n2\n 70\n1\n 10\n0\n 20\n0\n 42\n1\n 10\n20\n 20\n0\n 42\n1\n" +
      "  0\nLINE\n  8\nCACHE\n 10\n0\n 20\n0\n 11\n5\n 21\n5\n" +
      "  0\nINSERT\n  8\n0\n  2\nCARRE\n 10\n200\n 20\n0\n 41\n2\n 42\n2\n" +
      "  0\nTEXT\n  8\n0\n  1\nBonjour\n",
    ));
    expect(r.unitMm).toBe(1);
    expect(r.shapes).toHaveLength(5);
    expect(r.shapes[0].stroke).toBe("#ff0000");
    expect(r.shapes[1].stroke).toBe("#0000ff");
    expect(r.skipped).toMatchObject({ "calque éteint": 1, texte: 1 });
    const out = writeSvg(r.shapes, { unitMm: r.unitMm, yUp: true })!;
    // De x = 0 (ligne) à x = 220 (carré de 10 mis à l'échelle 2 en 200).
    const [w, h] = sizeOf(out.svg);
    expect(w).toBeCloseTo(220, 0);
    expect(h).toBeCloseTo(70, 0);
    // De y = -10 (bas du cercle à renflements) à y = 60 (haut du cercle).
    const doc = readSvgShapes(out.svg);
    expect(doc.shapes.length).toBe(5);
  });

  it("convertit les unités et lit ellipses et splines", () => {
    const r = readDxf(dxf(
      "  0\nELLIPSE\n  8\n0\n 10\n0\n 20\n0\n 11\n2\n 21\n0\n 40\n0.5\n 41\n0\n 42\n6.283185307\n" +
      "  0\nSPLINE\n  8\n0\n 71\n3\n 72\n8\n 40\n0\n 40\n0\n 40\n0\n 40\n0\n 40\n1\n 40\n1\n 40\n1\n 40\n1\n 73\n4\n 10\n0\n 20\n0\n 10\n1\n 20\n2\n 10\n3\n 20\n2\n 10\n4\n 20\n0\n",
      "  9\n$INSUNITS\n 70\n1\n",
    ));
    expect(r.unitMm).toBe(25.4);
    expect(r.shapes).toHaveLength(2);
    const spline = r.shapes[1].segs;
    const first = spline[0] as { x: number; y: number }, last = spline[spline.length - 1] as { x: number; y: number };
    expect(first.x).toBeCloseTo(0);
    expect(last.x).toBeCloseTo(4, 3);
    expect(last.y).toBeCloseTo(0, 3);
  });

  it("couleur 7 d'AutoCAD = noir, palette ACI", () => {
    expect(aciColor(7)).toBe("#000000");
    expect(aciColor(1)).toBe("#ff0000");
    expect(aciColor(10)).toBe("#ff0000");
    expect(aciColor(250)).toBe("#333333");
  });

  it("devient un programme G-code", async () => {
    const res = await importBytes(enc(dxf("  0\nCIRCLE\n  8\nDECOUPE\n 10\n0\n 20\n0\n 40\n10\n")), { name: "rond.dxf" });
    expect(res.kind).toBe("vector");
    expect(res.widthMm).toBeCloseTo(20, 1);
    expect(res.colors).toEqual(["#ff0000"]);
    const g = svgToGcode(res.svg!, { ...TOOLPATH_DEFAULTS, ops: [{ color: "#ff0000", mode: "line", power: 80, speed: 300, passes: 1, interval: 0.1, kerf: 0 }] });
    expect(g.error).toBeNull();
    expect(g.sizeMm?.w).toBeCloseTo(20, 0);
  });
});

describe("HPGL", () => {
  it("lit plumes, traits relatifs et cercles", () => {
    const r = readHpgl("IN;SP1;PU0,0;PD4000,0,4000,4000;PU;SP2;PA8000,0;PR;PD0,400;PA;PU;CI400;");
    expect(r.unitMm).toBe(0.025);
    expect(r.shapes).toHaveLength(3);
    expect(r.shapes[0].stroke).toBe("#000000");
    expect(r.shapes[1].stroke).toBe("#ff0000");
    const out = writeSvg(r.shapes, { unitMm: r.unitMm, yUp: true })!;
    const [w, h] = sizeOf(out.svg);
    expect(w).toBeCloseTo(210, 0);
    expect(h).toBeCloseTo(100, 0);
  });
});

/** PDF minimal : une page, un contenu (compressé ou non), un formulaire XObject. */
function makePdf(content: string, compress: boolean, form = ""): Uint8Array {
  const objs: string[] = [];
  const body = compress ? latinStr(deflateSync(Buffer.from(content, "latin1"))) : content;
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595.28 841.89] >>");
  objs.push(`<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /F1 5 0 R >> >> >>`);
  objs.push(`<< /Length ${body.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n${body}\nendstream`);
  objs.push(`<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 100 0] /Length ${form.length} >>\nstream\n${form}\nendstream`);
  let out = "%PDF-1.4\n";
  objs.forEach((o, k) => (out += `${k + 1} 0 obj\n${o}\nendobj\n`));
  out += "trailer\n<< /Root 1 0 R >>\n%%EOF\n";
  return latin(out);
}
const latinStr = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

describe("PDF et Illustrator", () => {
  it("lit tracés, couleurs et formulaires, en millimètres", async () => {
    const pdf = makePdf("q 1 0 0 RG 0 0 m 72 0 l S Q 0 0 1 rg 0 72 72 72 re f BT /F1 12 Tf (x) Tj ET /F1 Do", true, "0 g 0 0 m 10 0 l 10 10 l h f");
    const res = await importBytes(pdf, { name: "plan.pdf" });
    expect(res.format).toBe("pdf");
    expect(res.colors.sort()).toEqual(["#000000", "#0000ff", "#ff0000"]);
    expect(res.skipped).toMatchObject({ texte: 1 });
    // Tout tient dans la page A4 : son cadre est gardé.
    expect(res.widthMm).toBeCloseTo(210, 0);
    expect(res.heightMm).toBeCloseTo(297, 0);
    const doc = readSvgShapes(res.svg!);
    expect(doc.shapes.length).toBe(3);
  });

  it("lit un .ai compatible PDF et refuse les PDF chiffrés", async () => {
    const res = await importBytes(makePdf("0 0 m 100 0 l 100 100 l S", false), { name: "logo.ai" });
    expect(res.format).toBe("ai");
    expect(res.svg).toContain("<path");
    const enc = latin(latinStr(makePdf("0 0 m 1 1 l S", false)).replace("trailer\n<< /Root 1 0 R >>", "trailer\n<< /Root 1 0 R /Encrypt 9 0 R >>"));
    await expect(importBytes(enc, { name: "x.pdf" })).rejects.toThrow(/chiffré/);
  });

  it("décode LZW", () => {
    // « ABABABA » : codes 65 66 258 260 257 sur 9 bits.
    const codes = [256, 65, 66, 258, 260, 257];
    let bits = "";
    for (const c of codes) bits += c.toString(2).padStart(9, "0");
    while (bits.length % 8) bits += "0";
    const bytes = Uint8Array.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
    expect(latinStr(lzw(bytes))).toBe("ABABABA");
  });
});

describe("PostScript / EPS", () => {
  it("interprète procédures, boucles, matrices et couleurs", () => {
    const ps = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 200 200
/carre { newpath 0 0 moveto 10 0 rlineto 0 10 rlineto -10 0 rlineto closepath } bind def
1 0 0 setrgbcolor
0 1 3 { gsave 20 mul 0 translate carre stroke grestore } for
0 setgray
100 100 25 0 360 arc fill
(texte) show
showpage`;
    const r = readPostScript(latin(ps));
    expect(r.shapes).toHaveLength(5);
    expect(r.shapes[0].stroke).toBe("#ff0000");
    expect(r.shapes[4].fill).toBe("#000000");
    expect(r.skipped).toMatchObject({ texte: 1 });
    const out = writeSvg(r.shapes, { unitMm: r.unitMm, yUp: true, page: r.page })!;
    expect(sizeOf(out.svg)[0]).toBeCloseTo((200 * 25.4) / 72, 0);
  });

  it("s'arrête sur une boucle infinie sans planter", () => {
    const r = readPostScript(latin("%!PS\n0 0 moveto 10 10 lineto stroke { 1 pop } loop"));
    expect(r.shapes).toHaveLength(1);
  });

  it("lit un Illustrator ancien", () => {
    const ai = `%!PS-Adobe-3.0
%%Creator: Adobe Illustrator(R) 8.0
%AI5_FileFormat 4.0
%%EndSetup
0 0 0 1 k
0 0 m
100 0 l
100 100 l
f
1 0 0 Xa
0 0 m 50 50 L S
%%PageTrailer`;
    const r = readPostScript(latin(ai));
    expect(r.shapes).toHaveLength(2);
    expect(r.shapes[0].fill).toBe("#000000");
    expect(r.shapes[1].stroke).toBe("#000000");
  });
});

describe("LightBurn", () => {
  it("lit formes, groupes, matrices et réglages des calques", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<LightBurnProject AppVersion="1.4.03" FormatVersion="1" MaterialHeight="0">
  <CutSetting type="Scan"><index Value="0"/><name Value="Gravure"/><maxPower Value="25"/><speed Value="100"/><numPasses Value="1"/><interval Value="0.08"/></CutSetting>
  <CutSetting type="Cut"><index Value="2"/><name Value="Coupe"/><maxPower Value="90"/><speed Value="5"/><numPasses Value="2"/></CutSetting>
  <Shape Type="Rect" CutIndex="2" W="40" H="20" Cr="2"><XForm>1 0 0 1 50 50</XForm></Shape>
  <Shape Type="Group"><XForm>1 0 0 1 10 0</XForm><Children>
    <Shape Type="Ellipse" CutIndex="0" Rx="5" Ry="5"><XForm>1 0 0 1 0 50</XForm></Shape>
  </Children></Shape>
  <Shape Type="Path" CutIndex="2"><XForm>1 0 0 1 0 0</XForm><VertList>V0 0c0x5c0y0V10 10c1x10c1y5V0 10</VertList><PrimList>B0 1L1 2L2 0</PrimList></Shape>
  <Shape Type="Bitmap" CutIndex="0" W="10" H="10"><XForm>1 0 0 1 0 0</XForm></Shape>
</LightBurnProject>`;
    const r = readLightburn(xml);
    expect(r.shapes).toHaveLength(3);
    expect(r.skipped).toMatchObject({ image: 1 });
    expect(r.ops).toEqual([
      { color: "#000000", mode: "fill", power: 25, speed: 6000, passes: 1, interval: 0.08, kerf: 0 },
      { color: "#ff0000", mode: "line", power: 90, speed: 300, passes: 2, interval: 0.1, kerf: 0 },
    ]);
    expect(r.shapes[1].fill).toBe("#000000");
    const last = r.shapes[2].segs;
    expect(last[1].t).toBe("C");
    expect(last[last.length - 1].t).toBe("Z");
  });

  it("lit l'ancien format .lbrn", () => {
    const xml = `<LightBurnProject><Shape Type="Path" CutIndex="1"><XForm>1 0 0 1 0 0</XForm><V vx="0" vy="0"/><V vx="20" vy="0"/><V vx="20" vy="5"/><P T="L" p0="0" p1="1"/><P T="L" p0="1" p1="2"/></Shape></LightBurnProject>`;
    const r = readLightburn(xml);
    expect(r.shapes).toHaveLength(1);
    expect(r.shapes[0].stroke).toBe("#0000ff");
  });
});

describe("G-code et images", () => {
  it("garde un programme prêt, sans les réglages machine", async () => {
    const res = await importBytes(enc("%\n; LightBurn\n$32=1\nG21\nG90\nM4 S0\nG0 X10 Y10\nG1 X20 S500 F1200\nM5\n%\n"), { name: "job.gcode" });
    expect(res.kind).toBe("program");
    expect(res.gcode).toEqual(["; LightBurn", "G21", "G90", "M4 S0", "G0 X10 Y10", "G1 X20 S500 F1200", "M5"]);
    expect(res.issues.join()).toMatch(/\$/);
    expect(readGcodeText("hello\nworld")).toEqual([]);
  });

  it("décode un TIFF gris 8 bits PackBits et un TIFF RVB", async () => {
    const tiff = (w: number, h: number, spp: number, photo: number, comp: number, data: number[]) => {
      const entries: [number, number, number, number][] = [
        [256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 8], [259, 3, 1, comp], [262, 3, 1, photo], [273, 4, 1, 0], [277, 3, 1, spp], [278, 3, 1, h], [279, 4, 1, data.length],
      ];
      const ifdOff = 8, dataOff = ifdOff + 2 + entries.length * 12 + 4;
      const buf = new Uint8Array(dataOff + data.length);
      const dv = new DataView(buf.buffer);
      buf.set([0x49, 0x49, 42, 0]);
      dv.setUint32(4, ifdOff, true);
      dv.setUint16(ifdOff, entries.length, true);
      entries.forEach(([tag, type, count, v], k) => {
        const e = ifdOff + 2 + k * 12;
        dv.setUint16(e, tag, true);
        dv.setUint16(e + 2, type, true);
        dv.setUint32(e + 4, count, true);
        if (type === 3) dv.setUint16(e + 8, tag === 273 ? dataOff : v, true);
        else dv.setUint32(e + 8, tag === 273 ? dataOff : v, true);
      });
      buf.set(data, dataOff);
      return buf;
    };
    // 4 × 1, PackBits : 3 répétitions de 0 puis 1 littéral 255.
    const gray = await readTiff(tiff(4, 1, 1, 1, 32773, [0xfe, 0, 0, 255]));
    expect(Array.from(gray.data.filter((_, i) => i % 4 === 0))).toEqual([0, 0, 0, 255]);
    const rgb = await readTiff(tiff(1, 1, 3, 2, 1, [255, 0, 10]));
    expect(Array.from(rgb.data)).toEqual([255, 0, 10, 255]);
  });

  it("décompresse un SVGZ", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="5mm" viewBox="0 0 10 5"><path d="M0 0 L10 5" stroke="#ff0000" fill="none"/></svg>';
    const res = await importBytes(new Uint8Array(gzipSync(Buffer.from(svg))), { name: "a.svgz" });
    expect(res.svg).toBe(svg);
    expect(res.widthMm).toBe(10);
    expect(res.colors).toEqual(["#ff0000"]);
  });
});
