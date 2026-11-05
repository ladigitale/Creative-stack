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

describe("sonic-trigger : sortie MIDI directe", () => {
  const seen = (id: string) => {
    const log: unknown[] = [];
    dp(id).onAssign((v: unknown) => void log.push(JSON.parse(JSON.stringify(v))));
    return log;
  };

  it("note : événement dans emit-provider puis compteur dans emit-trigger (ordre événements → déclencheur)", async () => {
    const order: string[] = [];
    dp("m1ev").onAssign(() => void order.push("events"));
    dp("m1go").onAssign(() => void order.push("go"));
    await mount({ source: "m1", key: "hit", emit: "note", "emit-provider": "m1ev", "emit-trigger": "m1go", note: "C4", "vel-min": "0.5", "dur-s": "0.4", "cooldown-ms": "0" });
    const evs = seen("m1ev");
    const go = seen("m1go");
    order.length = 0;
    set("m1", { hit: true });
    expect(evs.at(-1)).toEqual([{ type: "note", note: "C4", vel: 0.5, durS: 0.4 }]);
    expect(go.at(-1)).toBe(1);
    expect(order).toEqual(["events", "go"]);
  });

  it("le compteur est initialisé à 0 (sonic-midi avale sa première valeur)", async () => {
    await mount({ source: "m2", key: "hit", emit: "note", "emit-provider": "m2ev", "emit-trigger": "m2go" });
    let v: unknown;
    dp("m2go").onAssign((x: unknown) => void (v = x));
    expect(v).toBe(0);
  });

  it("noteOn tenue jusqu'au retour à faux, puis noteOff de la même note", async () => {
    await mount({ source: "m3", key: "on", emit: "noteOn", "emit-provider": "m3ev", "emit-trigger": "m3go", note: "64", "cooldown-ms": "0" });
    const evs = seen("m3ev");
    set("m3", { on: true });
    expect(evs.at(-1)).toEqual([{ type: "noteOn", note: 64, vel: 0.3 }]);
    set("m3", { on: false });
    expect(evs.at(-1)).toEqual([{ type: "noteOff", note: 64 }]);
  });

  it("hauteur lue dans la source (note-key) et calée sur la gamme", async () => {
    await mount({ source: "m4", key: "go", emit: "noteOn", "emit-provider": "m4ev", "note-key": "pos", "note-range": "48,72", scale: "0,2,4,7,9", "cooldown-ms": "0" });
    const evs = seen("m4ev");
    set("m4", { go: true, pos: 0.5 });
    const n = (evs.at(-1) as Array<{ note: number }>)[0].note;
    expect([0, 2, 4, 7, 9]).toContain((n - 48) % 12);
    expect(n).toBeGreaterThanOrEqual(55);
    expect(n).toBeLessThanOrEqual(65);
  });

  it("vélocité lue dans vel-source au moment du déclenchement, entre vel-min et 1", async () => {
    await mount({ source: "m5", key: "go", emit: "note", "emit-provider": "m5ev", "vel-source": "m5v", "vel-key": "peakVel", "vel-min": "0.2", "cooldown-ms": "0" });
    const evs = seen("m5ev");
    set("m5v", { peakVel: 1 });
    set("m5", { go: true });
    expect((evs.at(-1) as Array<{ vel: number }>)[0].vel).toBe(1);
    set("m5", { go: false });
    set("m5v", { peakVel: 0 });
    set("m5", { go: true });
    expect((evs.at(-1) as Array<{ vel: number }>)[0].vel).toBe(0.2);
  });

  it("canal MIDI transmis ; sans emit rien n'est publié", async () => {
    await mount({ source: "m6", key: "go", emit: "note", "emit-provider": "m6ev", ch: "3", "cooldown-ms": "0" });
    await mount({ source: "m6b", key: "go", "emit-provider": "m6bev", "cooldown-ms": "0" });
    const evs = seen("m6ev");
    const none = seen("m6bev");
    set("m6", { go: true });
    set("m6b", { go: true });
    expect((evs.at(-1) as Array<{ ch: number }>)[0].ch).toBe(3);
    expect(none.some((x) => Array.isArray(x))).toBe(false);
  });

  it("noteOn relâchée quand le composant est retiré (pas de note bloquée)", async () => {
    const el = await mount({ source: "m7", key: "go", emit: "noteOn", "emit-provider": "m7ev", note: "60", "cooldown-ms": "0" });
    const evs = seen("m7ev");
    set("m7", { go: true });
    el.remove();
    expect(evs.at(-1)).toEqual([{ type: "noteOff", note: 60 }]);
  });
});
