import { describe, expect, it } from "vitest";
import { parseCssColor, parseSvgDocument, parseTransform } from "./svgdoc";

const svg = (body: string, attrs = 'viewBox="0 0 100 100"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const total = (r: ReturnType<typeof parseSvgDocument>) => r.paths.reduce((n, p) => n + p.area, 0);

describe("lecture d'un SVG (formes exactes)", () => {
  it("formes de base, viewBox décalé, transform ; couleurs et ordre de dessin", () => {
    const r = parseSvgDocument(svg('<rect x="10" y="10" width="20" height="10" fill="#ff0000"/><g transform="translate(5 0)"><circle cx="50" cy="50" r="10" fill="blue"/></g>', 'viewBox="10 10 100 100"'));
    expect(r.width).toBe(100);
    expect(r.height).toBe(100);
    expect(r.paths.map((p) => p.color)).toEqual(["#ff0000", "#0000ff"]);
    expect(r.paths[0].area).toBeCloseTo(200, 0);
    expect(r.paths[1].area).toBeGreaterThan(Math.PI * 100 * 0.97);
    // viewBox x=10 : le rect commence à 0.
    expect(r.paths[0].d.startsWith("M0,0") || /M0[,.]/.test(r.paths[0].d)).toBe(true);
  });

  it("règle de remplissage : nonzero unit, evenodd troue ; un trou de sens opposé reste un trou", () => {
    const two = "M0,0H20V20H0Z M10,10H30V30H10Z";
    expect(total(parseSvgDocument(svg(`<path d="${two}"/>`)))).toBeCloseTo(700, 0);
    expect(total(parseSvgDocument(svg(`<path d="${two}" fill-rule="evenodd"/>`)))).toBeCloseTo(600, 0);
    const donut = "M0,0H40V40H0Z M10,10V30H30V10Z";
    expect(total(parseSvgDocument(svg(`<path d="${donut}"/>`)))).toBeCloseTo(1200, 0);
  });

  it("contour changé en forme pleine (bouts arrondis), épaisseur mise à l'échelle", () => {
    const r = parseSvgDocument(svg('<line x1="10" y1="50" x2="90" y2="50" stroke="#000" stroke-width="4"/>'));
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0].area).toBeGreaterThan(80 * 4);
    expect(r.paths[0].area).toBeLessThan(80 * 4 + Math.PI * 4 + 1);
    const s = parseSvgDocument(svg('<g transform="scale(2)"><line x1="0" y1="10" x2="20" y2="10" stroke="#000" stroke-width="1"/></g>'));
    expect(s.paths[0].area).toBeGreaterThan(40 * 2);
  });

  it("styles : <style>, style=\"\", currentColor, dégradé moyen, opacités, none, display:none", () => {
    const r = parseSvgDocument(svg(`
      <style>.a { fill: #00ff00 } rect.b { fill: rgb(0, 0, 255) } #c { fill: hsl(0, 100%, 50%) }</style>
      <defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>
      <rect class="a" width="10" height="10" fill="#123456"/>
      <rect class="b" width="10" height="10"/>
      <rect id="c" width="10" height="10"/>
      <rect width="10" height="10" style="fill: #abcdef; fill-opacity: .5"/>
      <g color="#654321" opacity="0.5"><rect width="10" height="10" fill="currentColor" opacity="0.5"/></g>
      <rect width="10" height="10" fill="url(#g)"/>
      <rect width="10" height="10" fill="none"/>
      <rect width="10" height="10" fill="red" display="none"/>`));
    expect(r.paths.map((p) => [p.color, p.opacity])).toEqual([
      ["#00ff00", 1], ["#0000ff", 1], ["#ff0000", 1], ["#abcdef", 0.5], ["#654321", 0.25], ["#808080", 1],
    ]);
  });

  it("use interne, symbole ; textes, images et scripts ignorés (comptés), jamais exécutés", () => {
    const r = parseSvgDocument(svg(`
      <defs><symbol id="s"><rect width="10" height="10" fill="#111111"/></symbol><circle id="o" r="5" fill="#222222"/></defs>
      <use href="#s" x="20"/><use href="#o" x="50" y="50"/>
      <text x="0" y="0">Bonjour</text><image href="x.png" width="10" height="10"/>
      <script>window.__pwned = true</script>`));
    expect(r.paths.map((p) => p.color)).toEqual(["#111111", "#222222"]);
    expect(r.skipped).toMatchObject({ text: 1, image: 1 });
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("sans viewBox : width / height, sinon la boîte du contenu ; erreurs", () => {
    expect(parseSvgDocument(svg('<rect width="10" height="10"/>', 'width="300" height="200"'))).toMatchObject({ width: 300, height: 200 });
    const r = parseSvgDocument(svg('<rect x="50" y="40" width="10" height="20"/>', ""));
    expect(r).toMatchObject({ width: 10, height: 20 });
    expect(() => parseSvgDocument("<html></html>")).toThrow();
    expect(() => parseSvgDocument("<svg><rect")).toThrow();
    expect(parseSvgDocument(svg('<text>seul</text>')).paths).toEqual([]);
  });

  it("transform et couleurs CSS", () => {
    expect(parseTransform("translate(10,20) scale(2)")).toEqual([2, 0, 0, 2, 10, 20]);
    const r = parseTransform("rotate(90 10 10)");
    expect(r.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, -1, 0, 20, 0]);
    expect(parseCssColor("#abc")).toEqual(["#aabbcc", 1]);
    expect(parseCssColor("rgba(255, 0, 0, .5)")).toEqual(["#ff0000", 0.5]);
    expect(parseCssColor("none")).toBeNull();
    expect(parseCssColor("navy")).toEqual(["#000080", 1]);
  });
});
