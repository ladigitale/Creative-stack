import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { set, get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { policyAllows, deviceError, describeElement } from "../../shared/device/base";
import { parsePattern, safeShareUrl } from "./index";
import type { SonicFullscreen } from "./fullscreen";
import type { SonicPointerLock } from "./pointer-lock";
import type { SonicWakeLock } from "./wake-lock";
import type { SonicOrientation } from "./orientation";
import type { SonicClipboard } from "./clipboard";
import type { SonicShare } from "./share";
import type { SonicVibrate } from "./vibrate";
import type { SonicPageState } from "./page-state";
import type { SonicCapabilities } from "./capabilities";

// ─── Doublures des API navigateur (restaurées après chaque test) ───────────────────────────────────────────────
type Restore = () => void;
let restores: Restore[] = [];
function stub(obj: object, key: string, desc: PropertyDescriptor): void {
  const before = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { configurable: true, ...desc });
  restores.push(() => {
    if (before) Object.defineProperty(obj, key, before);
    else delete (obj as Record<string, unknown>)[key];
  });
}
const val = (value: unknown): PropertyDescriptor => ({ value, writable: true });
const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const domError = (name: string, message = name) => Object.assign(new Error(message), { name });

async function mount<T extends HTMLElement & { updateComplete: Promise<boolean> }>(html: string, selector: string): Promise<T> {
  document.body.insertAdjacentHTML("beforeend", html);
  const el = document.querySelector(selector) as T;
  await el.updateComplete;
  return el;
}

beforeEach(() => {
  restores = [];
});
afterEach(() => {
  document.body.innerHTML = "";
  for (const r of restores.reverse()) r();
});

// ─── Socle ───────────────────────────────────────────────────────────────────────────────────────────────────────
describe("socle device", () => {
  it("policyAllows : inconnu sans API, valeur de la politique sinon, nom inconnu ignoré", () => {
    expect(policyAllows(null)).toBe("unknown");
    expect(policyAllows("fullscreen")).toBe("unknown");
    stub(document, "permissionsPolicy", val({ allowsFeature: (n: string) => n !== "camera", features: () => ["fullscreen", "camera"] }));
    expect(policyAllows("fullscreen")).toBe(true);
    expect(policyAllows("camera")).toBe(false);
    expect(policyAllows("inconnue")).toBe("unknown");
  });

  it("deviceError : refus de geste, non supporté, état invalide, message d'origine", () => {
    expect(deviceError(domError("NotAllowedError"), "plein écran")).toMatchObject({ status: "denied" });
    expect(deviceError(domError("SecurityError"), "x").status).toBe("denied");
    expect(deviceError(domError("NotSupportedError"), "x").status).toBe("unsupported");
    expect(deviceError(domError("InvalidStateError"), "x").status).toBe("error");
    expect(deviceError(new Error("boum"), "x")).toEqual({ status: "error", error: "boum" });
    expect(deviceError("texte", "wake lock").error).toBe("wake lock : erreur");
  });

  it("describeElement", () => {
    document.body.innerHTML = `<div id="scene"></div><canvas class="vue autre"></canvas><p></p>`;
    expect(describeElement(document.getElementById("scene"))).toBe("div#scene");
    expect(describeElement(document.querySelector("canvas"))).toBe("canvas.vue");
    expect(describeElement(document.querySelector("p"))).toBe("p");
    expect(describeElement(null)).toBeNull();
  });
});

// ─── sonic-fullscreen ────────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-fullscreen", () => {
  let fsEl: Element | null = null;
  const change = () => document.dispatchEvent(new Event("fullscreenchange"));

  beforeEach(() => {
    fsEl = null;
    stub(document, "fullscreenElement", { get: () => fsEl });
    stub(Element.prototype, "requestFullscreen", val(async function (this: Element) { fsEl = this; change(); }));
    stub(document, "exitFullscreen", val(async () => { fsEl = null; change(); }));
  });

  it("entre, sort, bascule ; l'état suit l'événement du navigateur", async () => {
    const el = await mount<SonicFullscreen>(`<div id="scene"></div><sonic-fullscreen id="fs1" target="#scene"></sonic-fullscreen>`, "sonic-fullscreen");
    expect(el.getState()).toMatchObject({ status: "idle", supported: true, active: false });
    expect(await el.run("enter")).toBe(true);
    expect(el.getState()).toMatchObject({ status: "ready", active: true, element: "div#scene", error: null });
    expect(get("fs1State")).toMatchObject({ active: true });
    await el.run("exit");
    expect(el.getState()).toMatchObject({ status: "idle", active: false, element: null });
    await el.run("toggle");
    expect(el.getState().active).toBe(true);
    await el.run("toggle");
    expect(el.getState().active).toBe(false);
  });

  it("sortie par Échap : suit fullscreenchange sans supposition + événement DOM", async () => {
    const el = await mount<SonicFullscreen>(`<sonic-fullscreen id="fs2"></sonic-fullscreen>`, "sonic-fullscreen");
    const seen: boolean[] = [];
    el.addEventListener("sonic-fullscreen-change", (e) => seen.push((e as CustomEvent).detail.active));
    await el.run("enter");
    fsEl = null;
    change();
    expect(el.getState().active).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("refus du navigateur : denied avec message, puis l'erreur disparaît au succès", async () => {
    const el = await mount<SonicFullscreen>(`<sonic-fullscreen id="fs3"></sonic-fullscreen>`, "sonic-fullscreen");
    stub(Element.prototype, "requestFullscreen", val(async () => { throw domError("TypeError"); }));
    stub(Element.prototype, "requestFullscreen", val(async () => { throw domError("NotAllowedError"); }));
    expect(await el.run("enter")).toBe(false);
    expect(el.getState()).toMatchObject({ status: "denied", active: false });
    expect(el.getState().error).toContain("refusé");
    stub(Element.prototype, "requestFullscreen", val(async function (this: Element) { fsEl = this; change(); }));
    expect(await el.run("enter")).toBe(true);
    expect(el.getState()).toMatchObject({ status: "ready", error: null });
  });

  it("cible introuvable, API absente (unsupported), commande inconnue", async () => {
    const el = await mount<SonicFullscreen>(`<sonic-fullscreen id="fs4" target="#nulle-part"></sonic-fullscreen>`, "sonic-fullscreen");
    expect(await el.run("enter")).toBe(false);
    expect(el.getState().error).toContain("introuvable");
    expect(await el.run("n-importe-quoi")).toBe(false);
    el.remove();
    stub(Element.prototype, "requestFullscreen", val(undefined));
    const el2 = await mount<SonicFullscreen>(`<sonic-fullscreen id="fs5"></sonic-fullscreen>`, "sonic-fullscreen");
    expect(el2.getState()).toMatchObject({ status: "unsupported", supported: false });
    expect(await el2.run("enter")).toBe(false);
  });

  it("pilotage par compteur et par clic direct (for)", async () => {
    const el = await mount<SonicFullscreen>(`<button id="bt"><span id="in">plein écran</span></button><sonic-fullscreen id="fs6" for="bt" control="fsCtl"></sonic-fullscreen>`, "sonic-fullscreen");
    set("fsCtl", { enter: 0, exit: 0 });
    expect(el.getState().active).toBe(false);
    set("fsCtl", { enter: 1, exit: 0 });
    await vi.waitFor(() => expect(el.getState().active).toBe(true));
    set("fsCtl", { enter: 1, exit: 1 });
    await vi.waitFor(() => expect(el.getState().active).toBe(false));
    // Clic sur un enfant du bouton : bascule.
    (document.getElementById("in") as HTMLElement).click();
    await vi.waitFor(() => expect(el.getState().active).toBe(true));
    (document.getElementById("bt") as HTMLElement).click();
    await vi.waitFor(() => expect(el.getState().active).toBe(false));
  });

  it("iPhone : plein écran seulement sur une <video> (supportsVideoOnly)", async () => {
    stub(Element.prototype, "requestFullscreen", val(undefined));
    stub(HTMLVideoElement.prototype, "webkitEnterFullscreen", val(function () {}));
    const page = await mount<SonicFullscreen>(`<sonic-fullscreen id="fs7"></sonic-fullscreen>`, "sonic-fullscreen");
    expect(page.getState()).toMatchObject({ supported: false, supportsVideoOnly: true });
    page.remove();
    const vid = await mount<SonicFullscreen>(`<video id="v"></video><sonic-fullscreen id="fs8" target="#v"></sonic-fullscreen>`, "sonic-fullscreen");
    expect(vid.getState()).toMatchObject({ supported: true, status: "idle" });
  });
});

// ─── sonic-pointer-lock ──────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-pointer-lock", () => {
  let locked: Element | null = null;
  const lockChange = () => document.dispatchEvent(new Event("pointerlockchange"));
  const move = (dx: number, dy: number) => {
    const e = new MouseEvent("mousemove");
    Object.defineProperty(e, "movementX", { value: dx });
    Object.defineProperty(e, "movementY", { value: dy });
    document.dispatchEvent(e);
  };

  beforeEach(() => {
    locked = null;
    stub(document, "pointerLockElement", { get: () => locked });
    stub(document, "exitPointerLock", val(() => { locked = null; lockChange(); }));
    stub(Element.prototype, "requestPointerLock", val(async function (this: Element) { locked = this; lockChange(); }));
  });

  it("verrouille, cumule les déplacements, publie la somme puis remet les deltas à zéro", async () => {
    const el = await mount<SonicPointerLock>(`<canvas id="c"></canvas><sonic-pointer-lock id="pl1" target="#c" rate="60"></sonic-pointer-lock>`, "sonic-pointer-lock");
    const moves: { dx: number; dy: number }[] = [];
    el.addEventListener("sonic-pointerlock-move", (e) => moves.push((e as CustomEvent).detail));
    move(5, 5); // verrou absent : ignoré
    expect(el.getState().x).toBe(0);
    expect(await el.run("lock")).toBe(true);
    expect(el.getState()).toMatchObject({ status: "ready", active: true, element: "canvas#c", x: 0, y: 0 });
    move(3, -1);
    move(2, -2);
    move(4, 0);
    expect(moves).toHaveLength(3);
    expect(el.getState()).toMatchObject({ x: 9, y: -3 });
    await wait(80);
    // Plus de mouvement : le dernier état publié a dx = dy = 0 mais garde la position cumulée.
    expect(get("pl1State")).toMatchObject({ dx: 0, dy: 0, x: 9, y: -3, active: true });
    await el.run("reset");
    expect(el.getState()).toMatchObject({ x: 0, y: 0 });
  });

  it("publication plafonnée : les deltas d'une rafale sont sommés, rien n'est perdu", async () => {
    const el = await mount<SonicPointerLock>(`<sonic-pointer-lock id="pl2" rate="20"></sonic-pointer-lock>`, "sonic-pointer-lock");
    await el.run("lock");
    const seen: number[] = [];
    const out = get("pl2State");
    expect(out).toBeTruthy();
    for (let i = 0; i < 10; i++) move(1, 0);
    await wait(120);
    seen.push((get("pl2State") as { x: number }).x);
    expect(seen[0]).toBe(10);
  });

  it("mouvement brut demandé : repli sans l'option quand le navigateur ne le connaît pas", async () => {
    const calls: unknown[] = [];
    stub(Element.prototype, "requestPointerLock", val(async function (this: Element, opts?: object) {
      calls.push(opts);
      if (opts) throw domError("NotSupportedError");
      locked = this;
      lockChange();
    }));
    const el = await mount<SonicPointerLock>(`<sonic-pointer-lock id="pl3" unadjusted-movement></sonic-pointer-lock>`, "sonic-pointer-lock");
    expect(await el.run("lock")).toBe(true);
    expect(calls).toEqual([{ unadjustedMovement: true }, undefined]);
    expect(el.getState()).toMatchObject({ active: true, raw: false });
    await el.run("unlock");
    // Navigateur qui accepte le mouvement brut : raw vrai.
    stub(Element.prototype, "requestPointerLock", val(async function (this: Element) { locked = this; lockChange(); }));
    expect(await el.run("lock")).toBe(true);
    expect(el.getState().raw).toBe(true);
  });

  it("requestPointerLock synchrone (Firefox, Safari) ; refus par événement pointerlockerror", async () => {
    stub(Element.prototype, "requestPointerLock", val(function (this: Element) { locked = this; queueMicrotask(lockChange); }));
    const el = await mount<SonicPointerLock>(`<sonic-pointer-lock id="pl4"></sonic-pointer-lock>`, "sonic-pointer-lock");
    await el.run("lock");
    await wait();
    expect(el.getState().active).toBe(true);
    await el.run("unlock");
    expect(el.getState().active).toBe(false);
    stub(Element.prototype, "requestPointerLock", val(function () { queueMicrotask(() => document.dispatchEvent(new Event("pointerlockerror"))); }));
    await el.run("lock");
    await wait();
    expect(el.getState()).toMatchObject({ status: "denied", active: false });
    expect(el.getState().error).toContain("allow-pointer-lock");
  });

  it("API absente : unsupported ; retrait de la page : verrou relâché", async () => {
    stub(Element.prototype, "requestPointerLock", val(undefined));
    const none = await mount<SonicPointerLock>(`<sonic-pointer-lock id="pl5"></sonic-pointer-lock>`, "sonic-pointer-lock");
    expect(none.getState()).toMatchObject({ status: "unsupported", supported: false });
    expect(await none.run("lock")).toBe(false);
    none.remove();
    stub(Element.prototype, "requestPointerLock", val(async function (this: Element) { locked = this; lockChange(); }));
    const el = await mount<SonicPointerLock>(`<sonic-pointer-lock id="pl6"></sonic-pointer-lock>`, "sonic-pointer-lock");
    await el.run("toggle");
    expect(locked).not.toBeNull();
    el.remove();
    expect(locked).toBeNull();
  });
});

// ─── sonic-wake-lock ─────────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-wake-lock", () => {
  type Fake = { released: boolean; release: () => Promise<void>; addEventListener: (t: string, h: () => void) => void; fireRelease: () => void };
  let sentinels: Fake[] = [];
  let vis = "visible";
  const mk = (): Fake => {
    const handlers: (() => void)[] = [];
    const s: Fake = {
      released: false,
      release: async () => { s.released = true; handlers.forEach((h) => h()); },
      addEventListener: (_t, h) => void handlers.push(h),
      fireRelease: () => { s.released = true; handlers.forEach((h) => h()); },
    };
    sentinels.push(s);
    return s;
  };
  const setVisible = (v: string) => { vis = v; document.dispatchEvent(new Event("visibilitychange")); };

  beforeEach(() => {
    sentinels = [];
    vis = "visible";
    stub(document, "visibilityState", { get: () => vis });
    stub(navigator, "wakeLock", val({ request: vi.fn(async () => mk()) }));
  });

  it("prend et rend le verrou", async () => {
    const el = await mount<SonicWakeLock>(`<sonic-wake-lock id="wl1"></sonic-wake-lock>`, "sonic-wake-lock");
    expect(el.getState()).toMatchObject({ status: "idle", supported: true, active: false, wanted: false });
    expect(await el.run("acquire")).toBe(true);
    expect(el.getState()).toMatchObject({ status: "ready", active: true, wanted: true, reacquired: 0 });
    expect(get("wl1State")).toMatchObject({ active: true });
    expect(await el.run("toggle")).toBe(true);
    expect(el.getState()).toMatchObject({ active: false, wanted: false, status: "idle" });
    expect(sentinels[0].released).toBe(true);
  });

  it("perdu en arrière-plan : repris au retour de l'onglet tant que l'intention reste (reacquired)", async () => {
    const el = await mount<SonicWakeLock>(`<sonic-wake-lock id="wl2"></sonic-wake-lock>`, "sonic-wake-lock");
    await el.run("acquire");
    setVisible("hidden");
    sentinels[0].fireRelease();
    expect(el.getState()).toMatchObject({ active: false, wanted: true });
    setVisible("visible");
    await vi.waitFor(() => expect(el.getState()).toMatchObject({ active: true, reacquired: 1 }));
    expect(sentinels).toHaveLength(2);
    // Après un relâchement voulu : aucune reprise.
    await el.run("release");
    setVisible("hidden");
    setVisible("visible");
    await wait(5);
    expect(el.getState()).toMatchObject({ active: false, wanted: false, reacquired: 1 });
  });

  it("onglet masqué : l'intention est gardée sans appel au navigateur", async () => {
    vis = "hidden";
    const el = await mount<SonicWakeLock>(`<sonic-wake-lock id="wl3"></sonic-wake-lock>`, "sonic-wake-lock");
    expect(await el.run("acquire")).toBe(false);
    expect(el.getState()).toMatchObject({ wanted: true, active: false, error: null });
    expect(sentinels).toHaveLength(0);
    setVisible("visible");
    await vi.waitFor(() => expect(el.getState().active).toBe(true));
  });

  it("refus (NotAllowedError) : denied ; auto : retente au premier geste", async () => {
    let allow = false;
    stub(navigator, "wakeLock", val({ request: vi.fn(async () => { if (!allow) throw domError("NotAllowedError"); return mk(); }) }));
    const el = await mount<SonicWakeLock>(`<sonic-wake-lock id="wl4" auto></sonic-wake-lock>`, "sonic-wake-lock");
    await vi.waitFor(() => expect(el.getState().status).toBe("denied"));
    expect(el.getState().active).toBe(false);
    allow = true;
    window.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(el.getState()).toMatchObject({ active: true, status: "ready", error: null }));
  });

  it("API absente : unsupported ; retrait de la page : verrou rendu", async () => {
    stub(navigator, "wakeLock", val(undefined));
    const none = await mount<SonicWakeLock>(`<sonic-wake-lock id="wl5"></sonic-wake-lock>`, "sonic-wake-lock");
    expect(none.getState()).toMatchObject({ status: "unsupported", supported: false });
    expect(await none.run("acquire")).toBe(false);
    none.remove();
    stub(navigator, "wakeLock", val({ request: async () => mk() }));
    const el = await mount<SonicWakeLock>(`<sonic-wake-lock id="wl6"></sonic-wake-lock>`, "sonic-wake-lock");
    await el.run("acquire");
    const held = sentinels[sentinels.length - 1];
    el.remove();
    await wait();
    expect(held.released).toBe(true);
  });
});

// ─── sonic-orientation ───────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-orientation", () => {
  let orient: { type: string; angle: number; lock: ReturnType<typeof vi.fn>; unlock: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
  const fire = (type: string, props: Record<string, unknown>) => {
    const e = new Event(type);
    Object.assign(e, props);
    window.dispatchEvent(e);
  };

  beforeEach(() => {
    orient = { type: "portrait-primary", angle: 0, lock: vi.fn(async () => undefined), unlock: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    stub(screen, "orientation", val(orient));
    stub(window, "DeviceOrientationEvent", val(class {}));
    stub(window, "DeviceMotionEvent", val(class {}));
  });

  it("lit l'orientation de l'écran et suit ses changements", async () => {
    const el = await mount<SonicOrientation>(`<sonic-orientation id="or1"></sonic-orientation>`, "sonic-orientation");
    expect(el.getState()).toMatchObject({ supported: true, type: "portrait-primary", angle: 0, locked: false, sensors: false, permission: "n/a", alpha: null });
    orient.type = "landscape-primary";
    orient.angle = 90;
    const onChange = orient.addEventListener.mock.calls.find((c) => c[0] === "change")![1] as () => void;
    onChange();
    expect(el.getState()).toMatchObject({ type: "landscape-primary", angle: 90 });
  });

  it("verrouille et déverrouille ; type inconnu refusé ; refus de sécurité : message plein écran", async () => {
    const el = await mount<SonicOrientation>(`<sonic-orientation id="or2"></sonic-orientation>`, "sonic-orientation");
    expect(await el.run("lock", { type: "landscape" })).toBe(true);
    expect(orient.lock).toHaveBeenCalledWith("landscape");
    expect(el.getState()).toMatchObject({ locked: true, status: "ready" });
    await el.run("unlock");
    expect(orient.unlock).toHaveBeenCalled();
    expect(el.getState()).toMatchObject({ locked: false, status: "idle" });
    expect(await el.run("lock", { type: "à-l'envers" })).toBe(false);
    expect(el.getState().error).toContain("inconnue");
    orient.lock.mockRejectedValueOnce(domError("SecurityError"));
    expect(await el.run("lock", {})).toBe(false);
    expect(el.getState()).toMatchObject({ status: "denied", locked: false });
    expect(el.getState().error).toContain("plein écran");
  });

  it("capteurs : valeurs arrondies, null tant que rien n'arrive, arrêt remet à null", async () => {
    const el = await mount<SonicOrientation>(`<sonic-orientation id="or3" rate="60"></sonic-orientation>`, "sonic-orientation");
    expect(await el.run("sensors")).toBe(true);
    expect(el.getState()).toMatchObject({ sensors: true, active: true, status: "ready", permission: "n/a" });
    fire("deviceorientation", { alpha: 10.26, beta: -45.04, gamma: null });
    fire("devicemotion", { accelerationIncludingGravity: { x: 0.123, y: 9.81, z: null }, rotationRate: { alpha: 1, beta: 2, gamma: 3 } });
    await wait(40);
    expect(get("or3State")).toMatchObject({ alpha: 10.3, beta: -45, gamma: null, ax: 0.1, ay: 9.8, az: null, ra: 1, rb: 2, rg: 3 });
    el.stopSensors();
    expect(el.getState()).toMatchObject({ sensors: false, alpha: null, ax: null, active: false });
    fire("deviceorientation", { alpha: 99, beta: 0, gamma: 0 });
    expect(el.getState().alpha).toBeNull();
  });

  it("lissage exponentiel, alpha par le plus court chemin", async () => {
    const el = await mount<SonicOrientation>(`<sonic-orientation id="or4" smoothing="0.5"></sonic-orientation>`, "sonic-orientation");
    await el.run("sensors");
    fire("deviceorientation", { alpha: 350, beta: 0, gamma: 0 });
    fire("deviceorientation", { alpha: 10, beta: 40, gamma: 0 });
    // 350 → 10 passe par 0 (et non par 180) : milieu à 0 (360).
    const { alpha, beta } = el.getState();
    expect(alpha === 0 || alpha === 360).toBe(true);
    expect(beta).toBe(20);
    fire("deviceorientation", { alpha: 10, beta: 40, gamma: 0 });
    expect(el.getState().beta).toBe(30);
  });

  it("iOS : permission demandée avant d'écouter ; refus → denied, accord → ready", async () => {
    const answers = ["denied", "granted"];
    const ask = vi.fn(async () => answers.shift() as string);
    stub(window, "DeviceOrientationEvent", val(Object.assign(class {}, { requestPermission: ask })));
    stub(window, "DeviceMotionEvent", val(Object.assign(class {}, { requestPermission: ask })));
    const el = await mount<SonicOrientation>(`<sonic-orientation id="or5"></sonic-orientation>`, "sonic-orientation");
    answers.splice(0, 2, "denied", "granted");
    expect(await el.run("sensors")).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(el.getState()).toMatchObject({ permission: "denied", status: "denied", sensors: false });
    answers.splice(0, 2, "granted", "granted");
    expect(await el.run("sensors")).toBe(true);
    expect(el.getState()).toMatchObject({ permission: "granted", sensors: true });
  });

  it("clic direct (for) démarre les capteurs ; compteur de verrouillage avec type", async () => {
    const el = await mount<SonicOrientation>(`<button id="go">go</button><sonic-orientation id="or6" for="go" control="orCtl"></sonic-orientation>`, "sonic-orientation");
    (document.getElementById("go") as HTMLElement).click();
    await vi.waitFor(() => expect(el.getState().sensors).toBe(true));
    set("orCtl", { lock: { n: 0, type: "portrait" } });
    set("orCtl", { lock: { n: 1, type: "portrait" } });
    await vi.waitFor(() => expect(orient.lock).toHaveBeenCalledWith("portrait"));
  });

  it("rien de supporté : unsupported", async () => {
    stub(screen, "orientation", val(undefined));
    stub(window, "DeviceOrientationEvent", val(undefined));
    stub(window, "DeviceMotionEvent", val(undefined));
    const el = await mount<SonicOrientation>(`<sonic-orientation id="or7"></sonic-orientation>`, "sonic-orientation");
    expect(el.getState()).toMatchObject({ status: "unsupported", supported: false });
    expect(await el.run("sensors")).toBe(false);
  });
});

// ─── sonic-clipboard ─────────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-clipboard", () => {
  let content = "";
  beforeEach(() => {
    content = "contenu du presse-papiers";
    stub(navigator, "clipboard", val({ writeText: vi.fn(async (t: string) => { content = t; }), readText: vi.fn(async () => content) }));
  });

  it("copie le texte de l'attribut ou celui de la commande, compte les copies", async () => {
    const el = await mount<SonicClipboard>(`<sonic-clipboard id="cb1" text="par défaut"></sonic-clipboard>`, "sonic-clipboard");
    expect(el.getState()).toMatchObject({ supported: true, copied: 0, text: null });
    expect(await el.run("copy")).toBe(true);
    expect(content).toBe("par défaut");
    expect(await el.run("copy", { n: 1, text: "autre" })).toBe(true);
    expect(content).toBe("autre");
    expect(get("cb1State")).toMatchObject({ copied: 2 });
  });

  it("ne lit jamais seul : seulement sur commande, texte tronqué", async () => {
    const el = await mount<SonicClipboard>(`<sonic-clipboard id="cb2"></sonic-clipboard>`, "sonic-clipboard");
    expect((navigator.clipboard.readText as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    content = "x".repeat(20000);
    expect(await el.run("read")).toBe(true);
    expect(el.getState().text).toHaveLength(10000);
  });

  it("refus : denied ; clic direct sur for ; API absente : unsupported", async () => {
    const el = await mount<SonicClipboard>(`<button id="cp">copier</button><sonic-clipboard id="cb3" for="cp" text="via clic"></sonic-clipboard>`, "sonic-clipboard");
    (document.getElementById("cp") as HTMLElement).click();
    await vi.waitFor(() => expect(content).toBe("via clic"));
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(domError("NotAllowedError"));
    expect(await el.run("copy")).toBe(false);
    expect(el.getState().status).toBe("denied");
    stub(navigator, "clipboard", val(undefined));
    expect(await el.run("copy")).toBe(false);
    expect(el.getState().status).toBe("unsupported");
  });
});

// ─── sonic-share ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-share", () => {
  let content = "";
  beforeEach(() => {
    content = "";
    stub(navigator, "share", val(vi.fn(async () => undefined)));
    stub(navigator, "canShare", val(undefined));
    stub(navigator, "clipboard", val({ writeText: vi.fn(async (t: string) => { content = t; }) }));
  });

  it("safeShareUrl : http(s) seulement", () => {
    expect(safeShareUrl("https://exemple.org/a?b=1")).toBe("https://exemple.org/a?b=1");
    expect(safeShareUrl("/page")).toMatch(/^http/);
    expect(safeShareUrl("javascript:alert(1)")).toBeNull();
    expect(safeShareUrl("data:text/html,<b>x</b>")).toBeNull();
    expect(safeShareUrl("  ")).toBeNull();
  });

  it("partage titre / texte / url ; les champs de la commande priment sur les attributs", async () => {
    const el = await mount<SonicShare>(`<sonic-share id="sh1" title="Titre" text="Texte" url="https://a.org/"></sonic-share>`, "sonic-share");
    expect(el.getState()).toMatchObject({ canShare: true, supported: true, shared: 0 });
    expect(await el.run("share")).toBe(true);
    expect(navigator.share).toHaveBeenLastCalledWith({ title: "Titre", text: "Texte", url: "https://a.org/" });
    await el.run("share", { n: 1, text: "Autre", url: "https://b.org/x" });
    expect(navigator.share).toHaveBeenLastCalledWith({ title: "Titre", text: "Autre", url: "https://b.org/x" });
    expect(get("sh1State")).toMatchObject({ shared: 2, via: "share", cancelled: 0 });
  });

  it("annulation par l'utilisateur : comptée, pas une erreur", async () => {
    const el = await mount<SonicShare>(`<sonic-share id="sh2" text="t"></sonic-share>`, "sonic-share");
    (navigator.share as ReturnType<typeof vi.fn>).mockRejectedValueOnce(domError("AbortError"));
    expect(await el.run("share")).toBe(false);
    expect(el.getState()).toMatchObject({ cancelled: 1, shared: 0, error: null, status: "idle" });
  });

  it("URL dangereuse refusée ; rien à partager refusé", async () => {
    const el = await mount<SonicShare>(`<sonic-share id="sh3"></sonic-share>`, "sonic-share");
    expect(await el.run("share", { url: "javascript:alert(1)" })).toBe(false);
    expect(el.getState().error).toContain("http(s)");
    expect(navigator.share).not.toHaveBeenCalled();
    expect(await el.run("share")).toBe(false);
    expect(el.getState().error).toContain("rien à partager");
  });

  it("sans partage natif : copie texte + url (repli) ; fallback=none : unsupported", async () => {
    stub(navigator, "share", val(undefined));
    const el = await mount<SonicShare>(`<sonic-share id="sh4" text="Regarde ça" url="https://a.org/"></sonic-share>`, "sonic-share");
    expect(el.getState()).toMatchObject({ canShare: false, supported: true });
    expect(await el.run("share")).toBe(true);
    expect(content).toBe("Regarde ça https://a.org/");
    expect(el.getState().via).toBe("clipboard");
    el.remove();
    const none = await mount<SonicShare>(`<sonic-share id="sh5" text="x" fallback="none"></sonic-share>`, "sonic-share");
    expect(none.getState()).toMatchObject({ supported: false, status: "unsupported" });
    expect(await none.run("share")).toBe(false);
  });

  it("canShare refuse la charge : repli par copie", async () => {
    stub(navigator, "canShare", val(() => false));
    const el = await mount<SonicShare>(`<sonic-share id="sh6" text="t" url="https://a.org/"></sonic-share>`, "sonic-share");
    expect(await el.run("share")).toBe(true);
    expect(navigator.share).not.toHaveBeenCalled();
    expect(el.getState().via).toBe("clipboard");
  });
});

// ─── sonic-vibrate ───────────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-vibrate", () => {
  it("parsePattern : nombre, texte, liste ; bornes et valeurs invalides", () => {
    expect(parsePattern(200)).toEqual([200]);
    expect(parsePattern("100, 50;100")).toEqual([100, 50, 100]);
    expect(parsePattern([10, "20", "x", 30])).toEqual([10, 20, 30]);
    expect(parsePattern(99999)).toEqual([5000]);
    expect(parsePattern(-5)).toEqual([0]);
    expect(parsePattern(Array(50).fill(1))).toHaveLength(20);
    expect(parsePattern(null)).toEqual([]);
    expect(parsePattern("abc")).toEqual([]);
  });

  it("vibre selon le motif ; active pendant le motif ; stop", async () => {
    const vib = vi.fn(() => true);
    stub(navigator, "vibrate", val(vib));
    const el = await mount<SonicVibrate>(`<sonic-vibrate id="vb1" pattern="30,10,30"></sonic-vibrate>`, "sonic-vibrate");
    expect(el.getState()).toMatchObject({ supported: true, count: 0, active: false });
    expect(await el.run("vibrate")).toBe(true);
    expect(vib).toHaveBeenLastCalledWith([30, 10, 30]);
    expect(el.getState()).toMatchObject({ active: true, count: 1, status: "ready" });
    await wait(90);
    expect(el.getState()).toMatchObject({ active: false, status: "idle" });
    await el.run("vibrate", { n: 1, pattern: 500 });
    expect(vib).toHaveBeenLastCalledWith([500]);
    await el.run("stop");
    expect(vib).toHaveBeenLastCalledWith(0);
    expect(el.getState().active).toBe(false);
  });

  it("refus du navigateur (false) : denied ; motif invalide ; API absente (iOS)", async () => {
    stub(navigator, "vibrate", val(vi.fn(() => false)));
    const el = await mount<SonicVibrate>(`<sonic-vibrate id="vb2"></sonic-vibrate>`, "sonic-vibrate");
    expect(await el.run("vibrate")).toBe(false);
    expect(el.getState()).toMatchObject({ status: "denied", active: false, count: 0 });
    expect(await el.run("vibrate", { pattern: "rien" })).toBe(false);
    expect(el.getState().error).toContain("invalide");
    el.remove();
    stub(navigator, "vibrate", val(undefined));
    const ios = await mount<SonicVibrate>(`<sonic-vibrate id="vb3"></sonic-vibrate>`, "sonic-vibrate");
    expect(ios.getState()).toMatchObject({ status: "unsupported", supported: false });
    expect(await ios.run("vibrate")).toBe(false);
  });
});

// ─── sonic-page-state ────────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-page-state", () => {
  let vis = "visible";
  beforeEach(() => {
    vis = "visible";
    stub(document, "visibilityState", { get: () => vis });
  });

  it("publie visibilité, focus, connexion, taille, préférences (sans matchMedia : valeurs sûres)", async () => {
    stub(window, "innerWidth", val(800));
    stub(window, "innerHeight", val(600));
    stub(window, "devicePixelRatio", val(2));
    const el = await mount<SonicPageState>(`<sonic-page-state id="ps1" rate="60"></sonic-page-state>`, "sonic-page-state");
    expect(get("ps1State")).toMatchObject({
      status: "ready", visible: true, active: true, width: 800, height: 600, dpr: 2,
      reducedMotion: false, colorScheme: "light", touch: false, hover: true,
    });
    vis = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(get("ps1State")).toMatchObject({ visible: false, active: false });
    vis = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(el.getState().visible).toBe(true);
  });

  it("suit le redimensionnement (plafonné) et les préférences par matchMedia", async () => {
    const listeners = new Map<string, () => void>();
    const prefs: Record<string, boolean> = { "(prefers-color-scheme: dark)": false, "(pointer: coarse)": false };
    stub(window, "matchMedia", val((q: string) => ({
      get matches() { return prefs[q] ?? (q.includes("hover") ? true : false); },
      addEventListener: (_t: string, h: () => void) => void listeners.set(q, h),
      removeEventListener: () => undefined,
    })));
    stub(window, "innerWidth", val(400));
    const el = await mount<SonicPageState>(`<sonic-page-state id="ps2" rate="60"></sonic-page-state>`, "sonic-page-state");
    expect(el.getState()).toMatchObject({ colorScheme: "light", touch: false });
    prefs["(prefers-color-scheme: dark)"] = true;
    prefs["(pointer: coarse)"] = true;
    listeners.get("(prefers-color-scheme: dark)")!();
    await wait(40);
    expect(get("ps2State")).toMatchObject({ colorScheme: "dark", touch: true });
    stub(window, "innerWidth", val(1024));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    await wait(40);
    expect(get("ps2State")).toMatchObject({ width: 1024 });
  });

  it("retrait de la page : plus aucun écouteur", async () => {
    const spy = vi.spyOn(window, "removeEventListener");
    const el = await mount<SonicPageState>(`<sonic-page-state id="ps3"></sonic-page-state>`, "sonic-page-state");
    el.remove();
    const types = spy.mock.calls.map((c) => c[0]);
    for (const t of ["focus", "blur", "online", "offline", "resize"]) expect(types).toContain(t);
    spy.mockRestore();
  });
});

// ─── sonic-capabilities ──────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-capabilities", () => {
  it("détecte par présence d'API, sans jamais ouvrir de demande de permission", async () => {
    const gum = vi.fn();
    const gdm = vi.fn();
    stub(navigator, "mediaDevices", val({ getUserMedia: gum, getDisplayMedia: gdm }));
    stub(navigator, "vibrate", val(() => true));
    stub(navigator, "share", val(async () => undefined));
    stub(navigator, "wakeLock", val({ request: vi.fn() }));
    stub(navigator, "clipboard", val({ writeText: vi.fn(), readText: vi.fn() }));
    stub(navigator, "getGamepads", val(() => []));
    stub(navigator, "requestMIDIAccess", val(vi.fn()));
    stub(navigator, "permissions", val(undefined));
    stub(Element.prototype, "requestPointerLock", val(() => undefined));
    stub(document, "fullscreenEnabled", val(true));
    const el = await mount<SonicCapabilities>(`<sonic-capabilities id="cap1"></sonic-capabilities>`, "sonic-capabilities");
    await el.refresh();
    const st = get("cap1State") as ReturnType<SonicCapabilities["getState"]>;
    expect(st.status).toBe("ready");
    expect(st.secureContext).toBe(true);
    expect(st.embedded).toBe(false);
    for (const k of ["fullscreen", "pointerLock", "wakeLock", "gamepad", "midi", "clipboard", "share", "vibrate", "camera", "microphone", "screen"] as const) {
      expect(st[k].supported, k).toBe(true);
    }
    expect(st.camera.permission).toBe("unknown");
    expect(st.pointerLock.permission).toBe("n/a");
    expect(gum).not.toHaveBeenCalled();
    expect(gdm).not.toHaveBeenCalled();
  });

  it("API absentes : supported false ; politique de la page lue quand elle existe", async () => {
    stub(navigator, "vibrate", val(undefined));
    stub(navigator, "share", val(undefined));
    stub(navigator, "mediaDevices", val(undefined));
    stub(navigator, "permissions", val(undefined));
    stub(document, "permissionsPolicy", val({ allowsFeature: (n: string) => n !== "midi", features: () => ["midi", "fullscreen"] }));
    const el = await mount<SonicCapabilities>(`<sonic-capabilities id="cap2"></sonic-capabilities>`, "sonic-capabilities");
    await el.refresh();
    const st = el.getState();
    expect(st.vibrate.supported).toBe(false);
    expect(st.share.supported).toBe(false);
    expect(st.camera.supported).toBe(false);
    expect(st.midi.allowed).toBe(false);
    expect(st.fullscreen.allowed).toBe(true);
    expect(st.vibrate.allowed).toBe("unknown");
  });

  it("permissions : état lu sans demande, changement suivi, nom refusé par le navigateur : unknown", async () => {
    stub(navigator, "mediaDevices", val({ getUserMedia: vi.fn() }));
    stub(navigator, "requestMIDIAccess", val(vi.fn()));
    const handlers: (() => void)[] = [];
    let cameraState = "prompt";
    const query = vi.fn(async ({ name }: { name: string }) => {
      if (name === "microphone") throw new TypeError("nom inconnu");
      return {
        get state() { return name === "camera" ? cameraState : "granted"; },
        addEventListener: (_t: string, h: () => void) => void handlers.push(h),
        removeEventListener: () => undefined,
      };
    });
    stub(navigator, "permissions", val({ query }));
    const el = await mount<SonicCapabilities>(`<sonic-capabilities id="cap3" control="capCtl"></sonic-capabilities>`, "sonic-capabilities");
    await vi.waitFor(() => expect(el.getState().camera.permission).toBe("prompt"));
    expect(el.getState().midi.permission).toBe("granted");
    expect(el.getState().microphone.permission).toBe("unknown");
    cameraState = "granted";
    handlers[0]();
    await vi.waitFor(() => expect(el.getState().camera.permission).toBe("granted"));
    // Relecture par compteur.
    const before = query.mock.calls.length;
    set("capCtl", { refresh: 0 });
    set("capCtl", { refresh: 1 });
    await vi.waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(before));
  });

  it("dans une iframe : embedded", async () => {
    stub(window, "top", val({}));
    const el = await mount<SonicCapabilities>(`<sonic-capabilities id="cap4"></sonic-capabilities>`, "sonic-capabilities");
    await el.refresh();
    expect(el.getState().embedded).toBe(true);
  });
});
