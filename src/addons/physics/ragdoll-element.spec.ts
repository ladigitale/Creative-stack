import { beforeAll, describe, expect, it, vi } from "vitest";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import type { SonicPhysics } from "./world";

type Ctx = Record<string, unknown>;

describe("sonic-ragdoll dans sonic-physics", () => {
  beforeAll(() => {
    const noop = () => {};
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({} as Ctx, { get: (t, k) => (k in t ? t[k as string] : noop), set: (t, k, v) => ((t[k as string] = v), true) })) as never;
  });

  async function mount(inner: string, attrs = ""): Promise<SonicPhysics> {
    const host = document.createElement("div");
    host.innerHTML = `<sonic-physics id="w${Math.random().toString(36).slice(2, 6)}" ${attrs} width="800" height="600" rate="60">${inner}</sonic-physics>`;
    document.body.append(host);
    const el = host.firstElementChild as SonicPhysics;
    await el.updateComplete;
    await Promise.resolve();
    return el;
  }

  it("crée les corps et publie la pose", async () => {
    const el = await mount('<sonic-ragdoll name="p" preset="humain" x="400" y="150" nodes-out="rd.pose"></sonic-ragdoll>', 'out-data-provider="rd.state"');
    const st = el.getState();
    expect(st.count).toBeGreaterThanOrEqual(13);
    expect(Object.keys(st.bodies)).toContain("p.torse");
    await vi.waitFor(() => expect(Object.keys((dp("rd.pose.nodes").get() as object) ?? {}).length).toBe(13));
    const nodes = dp("rd.pose.nodes").get() as Record<string, { x: number; y: number; rz: number }>;
    expect(nodes.torse.x).toBeCloseTo(400, -1);
    expect(dp("rd.pose.present").get()).toBe(1);
    const bones = dp("rd.pose.bones").get() as Record<string, { length: number }>;
    expect(bones.torse.length).toBe(110);
    el.remove();
  });

  it("les os en enfants modifient le préréglage", async () => {
    const el = await mount('<sonic-ragdoll name="q" preset="humain" nodes-out="rd2.pose"><sonic-bone name="tete" length="90"></sonic-bone></sonic-ragdoll>');
    await vi.waitFor(() => expect(dp("rd2.pose.bones").get()).toBeTruthy());
    expect((dp("rd2.pose.bones").get() as Record<string, { length: number }>).tete.length).toBe(90);
    el.remove();
  });

  it("signale un préréglage inconnu", async () => {
    const el = await mount('<sonic-ragdoll name="z" preset="martien"></sonic-ragdoll>');
    expect(el.getState().errors.join(" ")).toContain("martien");
    el.remove();
  });
});
