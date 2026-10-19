import { afterEach, describe, expect, it, vi } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./index";
import "../audio/mic";
import type { SonicCamera } from "./camera";
import type { SonicVideo } from "./video";
import type { SonicMic } from "../audio/mic";

const tick = () => new Promise((r) => setTimeout(r, 0));

// jsdom n'implémente pas la lecture média.
Object.assign(HTMLMediaElement.prototype, {
  load() {},
  pause() {},
  play: () => Promise.resolve(),
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/** Piste simulée : zoom et torche, `applyConstraints` écrit dans les réglages relus. */
function fakeCameraStream() {
  const live: Record<string, unknown> = { deviceId: "d1", facingMode: "user", width: 1280, height: 720, zoom: 1, torch: false };
  const track = {
    addEventListener() {},
    getCapabilities: () => ({ zoom: { min: 1, max: 4, step: 0.1 }, torch: true, focusMode: ["continuous", "manual"] }),
    getSettings: () => ({ ...live }),
    applyConstraints: vi.fn(async (c: MediaTrackConstraints) => {
      for (const set of c.advanced ?? []) Object.assign(live, set);
    }),
    stop: vi.fn(),
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  return { track, stream, live };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

describe("sonic-camera : réglages de la piste", () => {
  it("publie les capacités à l'ouverture, applique le DP `adjust` (valeur initiale et mises à jour) et relit la piste", async () => {
    const { track, stream } = fakeCameraStream();
    const getUserMedia = vi.fn(() => Promise.resolve(stream));
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
    PublisherManager.get("camAdj1").set({ zoom: 2, torch: true });
    document.body.innerHTML = `<sonic-camera id="camx1" adjust="camAdj1"></sonic-camera>`;
    const el = document.querySelector("sonic-camera") as SonicCamera;
    await el.updateComplete;
    await settle();
    // Avant l'ouverture : capacités indisponibles, rien demandé au navigateur.
    expect(PublisherManager.get("camx1Capabilities").get()).toMatchObject({ status: "unavailable", list: [] });
    expect(getUserMedia).not.toHaveBeenCalled();

    el.start();
    await settle();
    const caps = PublisherManager.get("camx1Capabilities").get() as Record<string, any>;
    expect(caps).toMatchObject({ status: "ready", deviceId: "d1", ptz: false });
    expect(caps.controls.zoom).toMatchObject({ kind: "range", min: 1, max: 4, step: 0.1, label: "Zoom" });
    expect(caps.controls.focusMode.values).toEqual(["continuous", "manual"]);
    expect(caps.list.map((d: { key: string }) => d.key)).toEqual(["focusMode", "zoom", "torch"]);

    // Valeurs déjà présentes dans le DP à l'ouverture : appliquées, bornées.
    let st = PublisherManager.get("camx1Settings").get() as Record<string, any>;
    expect(st.desired).toEqual({ zoom: 2, torch: true });
    expect(st.applied).toMatchObject({ zoom: 2, torch: true });
    expect(track.applyConstraints).toHaveBeenCalledTimes(2);

    // Mise à jour en direct, valeur hors bornes → bornée.
    PublisherManager.get("camAdj1").set({ zoom: 9 });
    await settle();
    st = PublisherManager.get("camx1Settings").get() as Record<string, any>;
    expect(st.desired.zoom).toBe(4);
    expect(st.applied.zoom).toBe(4);
    expect(st.errors).toEqual({});
  });

  it("n'ajoute pan / tilt / zoom à la demande d'accès qu'avec `ptz`", async () => {
    const { stream } = fakeCameraStream();
    const getUserMedia = vi.fn((_c: MediaStreamConstraints) => Promise.resolve(stream));
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
    document.body.innerHTML = `<sonic-camera id="camx2" active></sonic-camera><sonic-camera id="camx3" active ptz></sonic-camera>`;
    await settle();
    const videos = getUserMedia.mock.calls.map((c) => c[0].video as Record<string, unknown>);
    expect(videos).toHaveLength(2);
    expect(videos[0]).not.toHaveProperty("zoom");
    expect(videos[1]).toMatchObject({ pan: true, tilt: true, zoom: true });
  });

  it("fermeture : capacités retirées, réglages demandés conservés", async () => {
    const { stream } = fakeCameraStream();
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: () => Promise.resolve(stream) } });
    PublisherManager.get("camAdj4").set({ zoom: 2 });
    document.body.innerHTML = `<sonic-camera id="camx4" active adjust="camAdj4"></sonic-camera>`;
    const el = document.querySelector("sonic-camera") as SonicCamera;
    await settle();
    expect((PublisherManager.get("camx4Capabilities").get() as { status: string }).status).toBe("ready");
    el.stop();
    await settle();
    expect(PublisherManager.get("camx4Capabilities").get()).toMatchObject({ status: "unavailable", list: [] });
    expect(PublisherManager.get("camx4Settings").get()).toMatchObject({ desired: { zoom: 2 }, applied: {} });
  });
});

describe("composants média (sans périphérique)", () => {
  it("caméra : rien au chargement, « unsupported » sans mediaDevices, aucune exception", async () => {
    document.body.innerHTML = `<sonic-camera id="c1"></sonic-camera>`;
    const el = document.querySelector("sonic-camera") as SonicCamera;
    await el.updateComplete;
    expect(el.getState().status).toBe("idle");
    el.start();
    await tick();
    await tick();
    expect(el.getState()).toMatchObject({ status: "unsupported", active: false });
    expect(el.getFrameCanvas()).toBeNull();
    expect(el.frameSeq).toBe(0);
  });

  it("caméra : permission refusée → denied + message", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })) },
    });
    document.body.innerHTML = `<sonic-camera id="c2" active></sonic-camera>`;
    const el = document.querySelector("sonic-camera") as SonicCamera;
    await el.updateComplete;
    await tick();
    await tick();
    expect(el.getState()).toMatchObject({ status: "denied", error: "accès à la caméra refusé" });
  });

  it("micro : pas d'accès avant start(), sortie nulle sans flux", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(Object.assign(new Error("x"), { name: "NotFoundError" })));
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
    document.body.innerHTML = `<sonic-mic id="m1" autostart></sonic-mic>`;
    const el = document.querySelector("sonic-mic") as SonicMic;
    await el.updateComplete;
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(el.getAudioOutput()).toBeNull();
    el.start();
    await tick();
    await tick();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(el.getState()).toMatchObject({ status: "error", error: "aucun micro trouvé" });
  });

  it("vidéo : URL dangereuse refusée, URL vide = idle", async () => {
    document.body.innerHTML = `<sonic-video id="v1" src="javascript:alert(1)"></sonic-video><sonic-video id="v2"></sonic-video>`;
    const [bad, empty] = [...document.querySelectorAll("sonic-video")] as SonicVideo[];
    await bad.updateComplete;
    await empty.updateComplete;
    await tick();
    expect(bad.getState()).toMatchObject({ status: "error" });
    expect(bad.getState().error).toContain("refusée");
    expect(empty.getState().status).toBe("idle");
  });
});
