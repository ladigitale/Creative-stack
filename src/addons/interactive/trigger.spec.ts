import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicTrigger } from "./trigger";
import { registerStore, unregisterStore } from "./registry";

void SonicTrigger;

type Msg = { type: string; payload?: unknown };
let got: Msg[];

beforeEach(() => {
  vi.useFakeTimers();
  got = [];
  registerStore({ id: "tg", dispatch: (a) => void got.push({ type: a.type, payload: a.payload }), getState: () => ({}), reset: () => {} });
});
afterEach(() => {
  unregisterStore("tg");
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function mount(attrs: Record<string, string | boolean>) {
  const el = document.createElement("sonic-trigger") as SonicTrigger;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, String(v));
  }
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("sonic-trigger", () => {
  it("envoie l'action à la montée de la condition, avec la valeur lue", async () => {
    await mount({ source: "tg1", key: "labels.person", gt: "0", target: "tg", type: "alerte", payload: '{"what":"personne"}', "cooldown-ms": "0" });
    set("tg1", { labels: { person: 0 } });
    expect(got).toEqual([]);
    set("tg1", { labels: { person: 2 } });
    expect(got).toEqual([{ type: "alerte", payload: { what: "personne", value: 2, count: 1 } }]);
    set("tg1", { labels: { person: 3 } });
    expect(got).toHaveLength(1); // même franchissement
  });

  it("maintien : confirmé par la boucle même sans nouvelle valeur", async () => {
    await mount({ source: "tg2", key: "present", target: "tg", "hold-ms": "500", "cooldown-ms": "0" });
    set("tg2", { present: true });
    expect(got).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(got).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe("trigger");
  });

  it("maintien non atteint : rien n'est envoyé", async () => {
    await mount({ source: "tg3", key: "present", target: "tg", "hold-ms": "500" });
    set("tg3", { present: true });
    await vi.advanceTimersByTimeAsync(300);
    set("tg3", { present: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(got).toHaveLength(0);
  });

  it("end-type au retour à faux, repos entre deux déclenchements", async () => {
    await mount({ source: "tg4", key: "db", gt: "-30", target: "tg", type: "bruit", "end-type": "calme", "cooldown-ms": "1000" });
    set("tg4", { db: -10 });
    set("tg4", { db: -50 });
    expect(got.map((g) => g.type)).toEqual(["bruit", "calme"]);
    set("tg4", { db: -10 }); // trop tôt : différé
    expect(got).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1100);
    expect(got.map((g) => g.type)).toEqual(["bruit", "calme", "bruit"]);
  });

  it("mode repeat", async () => {
    await mount({ source: "tg5", key: "on", target: "tg", mode: "repeat", "cooldown-ms": "500" });
    set("tg5", { on: true });
    await vi.advanceTimersByTimeAsync(1200);
    expect(got.length).toBeGreaterThanOrEqual(3);
  });

  it("disabled : aucune action", async () => {
    await mount({ source: "tg6", key: "on", target: "tg", disabled: true });
    set("tg6", { on: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(got).toHaveLength(0);
  });

  it("charge utile illisible : seule la valeur est envoyée ; cible absente : sans effet", async () => {
    await mount({ source: "tg7", key: "on", target: "tg", payload: "{pas du json", "cooldown-ms": "0" });
    set("tg7", { on: true });
    expect(got).toEqual([{ type: "trigger", payload: { value: true, count: 1 } }]);
    await mount({ source: "tg7b", key: "on", target: "absent" });
    expect(() => set("tg7b", { on: true })).not.toThrow();
  });

  it("publie son état", async () => {
    await mount({ source: "tg8", key: "on", target: "tg", "state-provider": "tg8State", "cooldown-ms": "0" });
    set("tg8", { on: true });
    expect(dp("tg8State").get()).toMatchObject({ active: true, armed: false, count: 1, value: true });
    set("tg8", { on: false });
    expect(dp("tg8State").get()).toMatchObject({ active: false, armed: true, count: 1 });
  });
});
