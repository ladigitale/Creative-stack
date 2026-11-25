import { afterEach, describe, expect, it } from "vitest";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicColorTracker } from "./color-tracker";
import { SonicMotionDetector } from "./motion-detector";

void SonicMotionDetector;
void SonicColorTracker;

function frame(w: number, h: number, paint: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...paint(x, y), 255], (y * w + x) * 4);
  return { data, width: w, height: h };
}

describe("sonic-motion-detector", () => {
  afterEach(() => (document.body.innerHTML = ""));

  it("allume une zone et envoie l'évènement, x lu en miroir", async () => {
    const el = document.createElement("sonic-motion-detector") as SonicMotionDetector;
    el.setAttribute("out-data-provider", "mvt1");
    el.setAttribute("zones", '{"gauche": [0, 0, 0.5, 1], "droite": [0.5, 0, 0.5, 1]}');
    el.setAttribute("mirror", "");
    document.body.appendChild(el);
    await el.updateComplete;
    const seen: string[] = [];
    el.addEventListener("zone", (e) => seen.push((e as CustomEvent).detail.zone));
    el.analyse(frame(32, 16, () => [10, 10, 10]), 0);
    // la main bouge à gauche de l'image : à droite de l'écran en miroir
    el.analyse(frame(32, 16, (x) => (x < 10 ? [240, 240, 240] : [10, 10, 10])), 50);
    const s = dp("mvt1").get() as any;
    expect(s.status).toBe("ready");
    expect(s.x).toBeGreaterThan(0.8);
    expect(s.zones.droite.active).toBe(true);
    expect(s.zones.gauche.active).toBe(false);
    expect(seen).toEqual(["droite"]);
  });
});

describe("sonic-color-tracker", () => {
  afterEach(() => (document.body.innerHTML = ""));

  it("suit la couleur, puis prend une autre couleur au point visé", async () => {
    const el = document.createElement("sonic-color-tracker") as SonicColorTracker;
    el.setAttribute("out-data-provider", "coul1");
    el.setAttribute("control", "coulCtl");
    el.setAttribute("color", "#e11d48");
    document.body.appendChild(el);
    await el.updateComplete;
    const f = frame(40, 20, (x, y) => (x >= 30 && y >= 5 && y < 12 ? [225, 30, 70] : x < 6 && y < 6 ? [20, 90, 220] : [230, 230, 225]));
    el.analyse(f);
    let s = dp("coul1").get() as any;
    expect(s.present).toBe(true);
    expect(s.x).toBeGreaterThan(0.75);
    dp("coulCtl").set({ pick: [0.05, 0.1], n: 0 });
    dp("coulCtl").set({ pick: [0.05, 0.1], n: 1 });
    el.analyse(f);
    s = dp("coul1").get() as any;
    expect(s.color).toBe("#145adc");
    expect(s.x).toBeLessThan(0.2);
  });
});
