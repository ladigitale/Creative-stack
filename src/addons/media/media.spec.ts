import { afterEach, describe, expect, it, vi } from "vitest";
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
