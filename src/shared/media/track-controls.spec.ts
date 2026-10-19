import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_KEYS,
  TrackAdjuster,
  describeCapabilities,
  emptyCapabilities,
  normalizeAdjust,
  sameValue,
  type CameraAdjustState,
  type CameraCapabilities,
} from "./track-controls";

const CAPS = {
  zoom: { min: 1, max: 5, step: 0.1 },
  torch: true,
  focusMode: ["continuous", "manual", "single-shot"],
  focusDistance: { min: 0.1, max: 2, step: 0.05 },
  exposureMode: ["continuous", "manual"],
  exposureCompensation: { min: -3, max: 3, step: 0.5 },
  iso: { min: 100, max: 100, step: 0 }, // plage dégénérée : aucun réglage
  whiteBalanceMode: ["continuous"], // un seul choix : aucun réglage
  pan: { min: -10, max: 10, step: 1 },
  width: { min: 1, max: 1920 }, // contrainte non gérée comme réglage
};
const SETTINGS = { deviceId: "dev1", zoom: 1, torch: false, focusMode: "continuous", exposureCompensation: 0 };

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Peut lancer une erreur (réglage refusé) ou renvoyer la valeur réellement retenue (arrondi). */
type Hook = (key: string, value: unknown) => unknown;

/** Piste simulée : `applyConstraints` écrit dans les réglages ; `hook` peut arrondir ou refuser. */
function fakeTrack(caps: Record<string, unknown> = CAPS, settings: Record<string, unknown> = SETTINGS, hook?: Hook) {
  const live: Record<string, unknown> = { ...settings };
  const calls: MediaTrackConstraints[] = [];
  const track = {
    getCapabilities: () => caps,
    getSettings: () => ({ ...live }),
    applyConstraints: vi.fn(async (c: MediaTrackConstraints) => {
      calls.push(c);
      for (const set of c.advanced ?? []) {
        for (const [k, v] of Object.entries(set)) {
          const kept = hook?.(k, v);
          live[k] = kept !== undefined ? kept : v;
        }
      }
    }),
  };
  return { track: track as unknown as MediaStreamTrack, calls, live };
}

describe("describeCapabilities", () => {
  const c = describeCapabilities(CAPS, SETTINGS, { ptz: false });

  it("décrit plages, énumérés et booléens avec libellé, unité et valeur courante", () => {
    expect(c.status).toBe("ready");
    expect(c.deviceId).toBe("dev1");
    expect(c.controls.zoom).toEqual({ key: "zoom", kind: "range", label: "Zoom", unit: "×", min: 1, max: 5, step: 0.1, value: 1 });
    expect(c.controls.torch).toMatchObject({ kind: "boolean", value: false });
    expect(c.controls.focusMode).toMatchObject({ kind: "enum", values: ["continuous", "manual", "single-shot"], value: "continuous" });
    expect(c.controls.exposureCompensation).toMatchObject({ min: -3, max: 3, step: 0.5, unit: "EV" });
  });

  it("écarte plages dégénérées, énumérés à un seul choix et contraintes non gérées", () => {
    expect(c.controls.iso).toBeUndefined();
    expect(c.controls.whiteBalanceMode).toBeUndefined();
    expect(c.unsupported).toEqual(expect.arrayContaining(["iso", "whiteBalanceMode", "colorTemperature", "brightness"]));
    expect(Object.keys(c.controls)).not.toContain("width");
  });

  it("pan / tilt seulement avec la permission PTZ", () => {
    expect(c.controls.pan).toBeUndefined();
    expect(c.ptz).toBe(false);
    const p = describeCapabilities(CAPS, SETTINGS, { ptz: true });
    expect(p.ptz).toBe(true);
    expect(p.controls.pan).toMatchObject({ kind: "range", min: -10, max: 10 });
  });

  it("`list` suit l'ordre sûr (modes avant valeurs) et ne contient que le pris en charge", () => {
    expect(c.list.map((d) => d.key)).toEqual(["focusMode", "exposureMode", "zoom", "focusDistance", "exposureCompensation", "torch"]);
    expect(c.list.length + c.unsupported.length).toBe(CONTROL_KEYS.length);
  });

  it("caméra qui ne sait rien : tout est non pris en charge, sans exception", () => {
    const e = describeCapabilities({}, {});
    expect(e.list).toEqual([]);
    expect(e.unsupported).toEqual(CONTROL_KEYS);
    expect(emptyCapabilities().status).toBe("unavailable");
  });

  it("torch annoncé sous forme de liste [true, false]", () => {
    expect(describeCapabilities({ torch: [false, true] }, {}).controls.torch).toBeDefined();
    expect(describeCapabilities({ torch: [false] }, {}).controls.torch).toBeUndefined();
  });
});

describe("normalizeAdjust", () => {
  const caps = describeCapabilities(CAPS, SETTINGS, { ptz: true });

  it("borne et aligne les nombres sur le pas", () => {
    const n = normalizeAdjust({ zoom: 9, exposureCompensation: 1.3, focusDistance: "0.12" }, caps);
    expect(Object.fromEntries(n.apply)).toEqual({ zoom: 5, exposureCompensation: 1.5, focusDistance: 0.1 });
    expect(n.errors).toEqual({});
  });

  it("met les modes avant les valeurs", () => {
    const n = normalizeAdjust({ focusDistance: 0.5, focusMode: "manual", zoom: 2 }, caps);
    expect(n.apply.map(([k]) => k)).toEqual(["focusMode", "zoom", "focusDistance"]);
  });

  it("refuse avec un message : énuméré hors liste, type invalide, réglage absent", () => {
    const n = normalizeAdjust({ focusMode: "auto", torch: "oui", zoom: "x", iso: 200 }, caps);
    expect(n.apply).toEqual([]);
    expect(n.errors.focusMode).toContain("continuous, manual, single-shot");
    expect(n.errors.torch).toBe("vrai ou faux attendu");
    expect(n.errors.zoom).toBe("nombre attendu");
    expect(n.errors.iso).toBe("non pris en charge par cette caméra");
  });

  it("`null` oublie une clé ; les clés étrangères du DP sont ignorées", () => {
    const n = normalizeAdjust({ zoom: null, active: true, facing: "user" }, caps);
    expect(n.release).toEqual(["zoom"]);
    expect(n.apply).toEqual([]);
    expect(n.errors).toEqual({});
  });

  it("entrée non objet : rien", () => {
    for (const v of [null, undefined, 3, "zoom", [1]]) expect(normalizeAdjust(v, caps)).toEqual({ apply: [], release: [], errors: {} });
  });

  it("caméra non démarrée : message explicite", () => {
    expect(normalizeAdjust({ zoom: 2 }, emptyCapabilities()).errors.zoom).toBe("caméra non démarrée");
  });
});

describe("sameValue", () => {
  const d = describeCapabilities(CAPS, SETTINGS).controls.zoom!;
  it("tolère un arrondi de la caméra", () => {
    expect(sameValue(2, 2.04, d)).toBe(true);
    expect(sameValue(2, 2.5, d)).toBe(false);
    expect(sameValue("manual", "manual")).toBe(true);
    expect(sameValue(true, undefined)).toBe(false);
  });
});

describe("TrackAdjuster", () => {
  function make(base?: () => MediaTrackConstraints) {
    const seen: { caps: CameraCapabilities; state: CameraAdjustState }[] = [];
    const adj = new TrackAdjuster((caps, state) => seen.push({ caps, state }), base);
    return { adj, seen };
  }

  it("applique un réglage à la fois, relit la piste et publie `applied`", async () => {
    const { track, calls } = fakeTrack();
    const { adj } = make();
    adj.attach(track, { ptz: false });
    adj.request({ zoom: 2, torch: true });
    await flush();
    expect(calls.map((c) => c.advanced)).toEqual([[{ zoom: 2 }], [{ torch: true }]]);
    expect(adj.getState().applied).toMatchObject({ zoom: 2, torch: true });
    expect(adj.getState().desired).toEqual({ zoom: 2, torch: true });
    expect(adj.getState().pending).toEqual([]);
    expect(adj.getState().errors).toEqual({});
  });

  it("applique les modes avant les valeurs", async () => {
    const { track, calls } = fakeTrack();
    const { adj } = make();
    adj.attach(track, { ptz: false });
    adj.request({ focusDistance: 0.5, focusMode: "manual" });
    await flush();
    expect(calls.map((c) => Object.keys(c.advanced![0])[0])).toEqual(["focusMode", "focusDistance"]);
  });

  it("garde les contraintes de base (résolution, cadence) à chaque application", async () => {
    const { track, calls } = fakeTrack();
    const { adj } = make(() => ({ width: { ideal: 1280 }, frameRate: { ideal: 30 } }));
    adj.attach(track, { ptz: false });
    adj.request({ zoom: 2 });
    await flush();
    expect(calls[0]).toMatchObject({ width: { ideal: 1280 }, frameRate: { ideal: 30 }, advanced: [{ zoom: 2 }] });
  });

  it("`applied` reflète ce que la caméra a vraiment retenu, pas la demande", async () => {
    const { track } = fakeTrack(CAPS, SETTINGS, (k) => (k === "zoom" ? 2.5 : undefined)); // la caméra arrondit le zoom
    const { adj } = make();
    adj.attach(track, { ptz: false });
    adj.request({ zoom: 2 });
    await flush();
    expect(adj.getState().desired.zoom).toBe(2);
    expect(adj.getState().applied.zoom).toBe(2.5);
  });

  it("un réglage refusé n'empêche pas les autres, et l'erreur est lisible", async () => {
    const { track } = fakeTrack(CAPS, SETTINGS, (k) => {
      if (k === "torch") throw Object.assign(new Error("x"), { name: "OverconstrainedError" });
    });
    const { adj } = make();
    adj.attach(track, { ptz: false });
    adj.request({ torch: true, zoom: 3 });
    await flush();
    expect(adj.getState().errors).toEqual({ torch: "valeur refusée par la caméra" });
    expect(adj.getState().applied.zoom).toBe(3);
    expect(adj.getState().pending).toEqual([]);
    // Une demande suivante valide efface l'erreur de la clé.
    adj.request({ torch: false });
    expect(adj.getState().errors.torch).toBeUndefined();
  });

  it("regroupe les demandes arrivées pendant une application (une seule en vol)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { track, calls } = fakeTrack();
    const real = (track as unknown as { applyConstraints: (c: MediaTrackConstraints) => Promise<void> }).applyConstraints;
    (track as unknown as { applyConstraints: (c: MediaTrackConstraints) => Promise<void> }).applyConstraints = async (c) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      await real(c);
      inFlight--;
    };
    const { adj } = make();
    adj.attach(track, { ptz: false });
    for (const z of [1.5, 2, 2.5, 3, 4]) adj.request({ zoom: z });
    await new Promise((r) => setTimeout(r, 60));
    expect(maxInFlight).toBe(1);
    expect(adj.getState().applied.zoom).toBe(4);
    expect(calls.length).toBeLessThan(5); // les valeurs intermédiaires sont sautées
  });

  it("une demande faite avant l'ouverture est mémorisée, bornée puis appliquée à l'ouverture", async () => {
    const { adj } = make();
    adj.request({ zoom: 99, torch: true, iso: 400, focusMode: "bogus" });
    expect(adj.getState().desired).toEqual({ zoom: 99, torch: true, iso: 400, focusMode: "bogus" });
    const { track, calls } = fakeTrack();
    adj.attach(track, { ptz: false });
    await flush();
    expect(adj.getState().desired).toMatchObject({ zoom: 5, torch: true, iso: 400 }); // zoom borné ; iso gardé (absent ici)
    expect(adj.getState().desired.focusMode).toBeUndefined(); // énuméré invalide : retiré
    expect(adj.getState().errors.focusMode).toContain("continuous");
    expect(adj.getState().errors.iso).toBe("non pris en charge par cette caméra");
    expect(calls.map((c) => c.advanced)).toEqual([[{ zoom: 5 }], [{ torch: true }]]);
  });

  it("changement de caméra : les réglages demandés sont réappliqués selon les capacités de la nouvelle", async () => {
    const { adj } = make();
    const first = fakeTrack();
    adj.attach(first.track, { ptz: false });
    adj.request({ zoom: 2, exposureCompensation: 1 });
    await flush();
    adj.detach();
    expect(adj.getCapabilities().status).toBe("unavailable");
    expect(adj.getState().desired).toMatchObject({ zoom: 2, exposureCompensation: 1 }); // conservés
    expect(adj.getState().applied).toEqual({});
    const second = fakeTrack({ zoom: { min: 1, max: 2, step: 0.1 } }, { deviceId: "dev2", zoom: 1 });
    adj.attach(second.track, { ptz: false });
    await flush();
    expect(adj.getState().applied.zoom).toBe(2);
    expect(adj.getState().errors.exposureCompensation).toBe("non pris en charge par cette caméra");
    expect(adj.getCapabilities().deviceId).toBe("dev2");
  });

  it("détacher pendant une application n'écrit rien sur l'ancienne piste ni dans l'état", async () => {
    const { track, calls } = fakeTrack();
    const real = (track as unknown as { applyConstraints: (c: MediaTrackConstraints) => Promise<void> }).applyConstraints;
    (track as unknown as { applyConstraints: (c: MediaTrackConstraints) => Promise<void> }).applyConstraints = async (c) => {
      await new Promise((r) => setTimeout(r, 5));
      await real(c);
    };
    const { adj } = make();
    adj.attach(track, { ptz: false });
    adj.request({ zoom: 2, torch: true });
    adj.detach();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBeLessThanOrEqual(1);
    expect(adj.getState().applied).toEqual({});
    expect(adj.getState().pending).toEqual([]);
  });

  it("`null` oublie un réglage demandé", async () => {
    const { track } = fakeTrack();
    const { adj } = make();
    adj.attach(track, { ptz: false });
    adj.request({ zoom: 2 });
    await flush();
    adj.request({ zoom: null });
    expect(adj.getState().desired.zoom).toBeUndefined();
  });
});
