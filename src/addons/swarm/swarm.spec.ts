import { afterEach, describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicSwarm } from "./swarm";

void SonicSwarm;

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sonic-swarm", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("publie nodes, sprites et agents dès la description", async () => {
    const el = document.createElement("sonic-swarm") as SonicSwarm;
    el.setAttribute("out-data-provider", "swOut1");
    el.setAttribute("spec", JSON.stringify({ seed: 2, groups: [{ name: "f", count: 3, radius: 4, sprite: { fill: "--sc-info" } }] }));
    document.body.appendChild(el);
    await el.updateComplete;
    await tick();
    const out = dp("swOut1").get() as Record<string, any>;
    expect(Object.keys(out.nodes)).toEqual(["f0", "f1", "f2"]);
    expect(out.nodes.f0).toMatchObject({ x: expect.any(Number), y: expect.any(Number), rz: expect.any(Number) });
    expect(out.sprites[0]).toMatchObject({ name: "f0", shape: "circle", r: 4, fill: "--sc-info" });
    expect(out.count).toBe(3);
    expect(out.status).toBe("ready");
  });

  it("description dans un DataProvider et réglages en direct par nom de groupe", async () => {
    set("swSpec", { groups: [{ name: "a", count: 2 }] });
    const el = document.createElement("sonic-swarm") as SonicSwarm;
    el.setAttribute("out-data-provider", "swOut2");
    el.setAttribute("spec", "swSpec");
    el.setAttribute("control", "swCtl");
    el.setAttribute("plane", "xz");
    document.body.appendChild(el);
    await el.updateComplete;
    await tick();
    expect((dp("swOut2").get() as any).count).toBe(2);
    set("swCtl", { groups: [{ name: "a", count: 5 }] });
    await tick();
    const out = dp("swOut2").get() as any;
    expect(out.count).toBe(5);
    expect(out.nodes.a4).toMatchObject({ x: expect.any(Number), z: expect.any(Number), ry: expect.any(Number) });
  });

  it("signale une description invalide et le dépassement du plafond", async () => {
    const el = document.createElement("sonic-swarm") as SonicSwarm;
    el.setAttribute("out-data-provider", "swOut3");
    el.setAttribute("spec", JSON.stringify({ groups: [{ name: "a", count: 500 }] }));
    document.body.appendChild(el);
    await el.updateComplete;
    await tick();
    const out = dp("swOut3").get() as any;
    expect(out.count).toBe(200);
    expect(out.error).toMatch(/200 au plus/);
  });
});

describe("sonic-swarm : rapport au store", () => {
  it("envoie positions, groupes et meneurs au store", async () => {
    const { registerStore } = await import("../interactive/registry");
    const got: { type: string; payload: any }[] = [];
    registerStore({ id: "rapport1", dispatch: (a: { type: string; payload: any }) => got.push(a) } as never);
    const el = document.createElement("sonic-swarm") as SonicSwarm;
    el.setAttribute("report", "rapport1");
    el.setAttribute("report-groups", "p");
    el.setAttribute("spec", JSON.stringify({ groups: [{ name: "p", count: 1 }, { name: "f", count: 3, follow: { target: "group:p" } }] }));
    document.body.appendChild(el);
    await el.updateComplete;
    (el as unknown as { sendReport(): void }).sendReport();
    const r = got.find((a) => a.type === "swarm:report")!;
    expect(Object.keys(r.payload.agents)).toEqual(["p0"]);
    expect(r.payload.groups).toEqual({ p: 1, f: 3 });
  });
});

describe("sonic-swarm : visible à chaque publication", () => {
  it("un rendu qui arrive après coup lit visible: true dans le dernier état", async () => {
    const el = document.createElement("sonic-swarm") as SonicSwarm;
    el.setAttribute("out-data-provider", "swVis");
    el.setAttribute("spec", JSON.stringify({ groups: [{ name: "f", count: 2 }] }));
    document.body.appendChild(el);
    await el.updateComplete;
    (el as unknown as { publish(w: boolean): void }).publish(false);
    const out = dp("swVis").get() as any;
    expect(out.nodes.f0.visible).toBe(true);
    expect(out.nodes.f1.visible).toBe(true);
    el.remove();
  });
});
