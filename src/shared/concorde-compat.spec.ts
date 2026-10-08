import { describe, expect, it, beforeEach } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import {
  evaluateIf,
  formatValue,
  isUnparsableJsonLike,
  pathGet,
} from "./concorde-compat";
import jsonata from "./jsonata-shim";

type LitEl = HTMLElement & { updateComplete: Promise<boolean> };

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mount(html: string): Promise<LitEl> {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  const el = host.firstElementChild as LitEl;
  await el.updateComplete;
  await tick();
  await el.updateComplete;
  return el;
}

const showsSlot = (el: HTMLElement) => !!el.shadowRoot?.querySelector("slot");

describe("règles sonic-if", () => {
  const rule = { key: "", equals: "", not: "", truthy: false, gt: "", lt: "" };
  it("chemins et comparaisons", () => {
    expect(pathGet({ a: { b: 3 } }, "a.b")).toBe(3);
    expect(pathGet({ a: null }, "a.b")).toBeUndefined();
    expect(evaluateIf({ s: "over" }, { ...rule, key: "s", equals: "over" })).toBe(true);
    expect(evaluateIf({ s: false }, { ...rule, key: "s", equals: "false" })).toBe(true);
    expect(evaluateIf({ s: "x" }, { ...rule, key: "s", not: "x" })).toBe(false);
    expect(evaluateIf({ n: 5 }, { ...rule, key: "n", gt: "4" })).toBe(true);
    expect(evaluateIf({ n: 5 }, { ...rule, key: "n", lt: "4" })).toBe(false);
    expect(evaluateIf({ n: 0 }, { ...rule, key: "n", truthy: true })).toBe(false);
  });
});

describe("sonic-if (Concorde classique complété)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("sans attributs : garde le mode .condition de Concorde", async () => {
    const el = (await mount("<sonic-if></sonic-if>")) as LitEl & { condition: boolean };
    expect(showsSlot(el)).toBe(false);
    el.condition = true;
    await el.updateComplete;
    expect(showsSlot(el)).toBe(true);
  });

  it("dataProvider + key + equals, et suit les changements du DataProvider", async () => {
    const pub = PublisherManager.get("compatIf1");
    pub.set({ game: { status: "play" } });
    const el = await mount(
      '<sonic-if dataProvider="compatIf1" key="game.status" equals="over">Game over</sonic-if>',
    );
    expect(showsSlot(el)).toBe(false);
    pub.set({ game: { status: "over" } });
    await tick();
    await el.updateComplete;
    expect(showsSlot(el)).toBe(true);
    pub.set({ game: { status: "play" } });
    await tick();
    await el.updateComplete;
    expect(showsSlot(el)).toBe(false);
  });

  it("dataProvider hérité d'un ancêtre", async () => {
    PublisherManager.get("compatIf2").set({ paused: true });
    const host = document.createElement("div");
    host.setAttribute("dataProvider", "compatIf2");
    host.innerHTML = '<sonic-if key="paused" truthy>Pause</sonic-if>';
    document.body.appendChild(host);
    const el = host.firstElementChild as LitEl;
    await el.updateComplete;
    await tick();
    await el.updateComplete;
    expect(showsSlot(el)).toBe(true);
  });

  it("réagit à un changement d'attribut", async () => {
    PublisherManager.get("compatIf3").set({ lvl: 3 });
    const el = await mount('<sonic-if dataProvider="compatIf3" key="lvl" gt="5"></sonic-if>');
    expect(showsSlot(el)).toBe(false);
    el.setAttribute("gt", "2");
    await tick();
    await el.updateComplete;
    expect(showsSlot(el)).toBe(true);
  });
});

describe("sonic-value (Concorde classique complété)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("formatValue", () => {
    expect(formatValue(42.7, "00000")).toBe("00042");
    expect(formatValue("abc", "00000")).toBe("abc");
    expect(formatValue(1234.5, "intl:fr-FR")).toBe(new Intl.NumberFormat("fr-FR").format(1234.5));
    expect(formatValue(0.25, "intl:fr-FR:percent")).toBe(
      new Intl.NumberFormat("fr-FR", { style: "percent" }).format(0.25),
    );
    expect(formatValue(7, "")).toBe("7");
  });

  it("format=00000 dans le rendu", async () => {
    PublisherManager.get("compatVal1").set({ score: 42 });
    const el = await mount('<sonic-value dataProvider="compatVal1" key="score" format="00000"></sonic-value>');
    expect(el.shadowRoot?.textContent?.trim()).toBe("00042");
  });

  it("sans format : rendu Concorde inchangé", async () => {
    PublisherManager.get("compatVal2").set({ label: "Niveau 3" });
    const el = await mount('<sonic-value dataProvider="compatVal2" key="label"></sonic-value>');
    expect(el.shadowRoot?.textContent?.trim()).toBe("Niveau 3");
  });

  it("une valeur « [Espace] pause » ne fait plus planter le Subscriber", async () => {
    expect(isUnparsableJsonLike("[Espace] pause")).toBe(true);
    expect(isUnparsableJsonLike("[1,2]")).toBe(false);
    expect(isUnparsableJsonLike("pause")).toBe(false);
    const pub = PublisherManager.get("compatVal3");
    pub.set({ hint: "ok" });
    const el = await mount('<sonic-value dataProvider="compatVal3" key="hint"></sonic-value>');
    expect(() => pub.set({ hint: "[Espace] pause" })).not.toThrow();
    await tick();
    await el.updateComplete;
    expect(el.shadowRoot?.textContent?.trim()).toBe("[Espace] pause");
  });
});

describe("fonctions JSONata creative-stack", () => {
  it("$cosine, $rankBySimilarity, $mediaUrl via le remplaçant de jsonata", async () => {
    expect(await jsonata("$cosine([1,0],[1,0])").evaluate({})).toBeCloseTo(1);
    expect(await jsonata('$mediaUrl({"url":"blob:x"})').evaluate({})).toBe("blob:x");
    const ranked = (await jsonata(
      '$rankBySimilarity(["a","b"], [[1,0],[0,1]], [0,1], 1)',
    ).evaluate({})) as unknown;
    expect(JSON.stringify(ranked)).toContain("b");
  });
});
