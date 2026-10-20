import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BOARD_GLB_B64 } from "./__fixtures__/board.glb.b64";
import { registerStore, unregisterStore } from "../interactive/registry";
import { asset } from "./asset";
import { load, type LoadCtx } from "./load";
import { NodeOverrides } from "./nodes";
import { parse } from "./parse";
import { pointer, type PointerHost } from "./pointer";

function scene() {
  const root = new THREE.Group();
  const shared = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  for (const n of ["m_10", "m_11"]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
    m.name = n;
    root.add(m);
  }
  return root;
}

describe("parse glb", () => {
  it("accepte base64 brut, data URI et champ asset.glb", () => {
    expect(parse.asset(`data:model/gltf-binary;base64,QUJD`)).toEqual({
      kind: "glb",
      glb: "QUJD",
    });
    expect(parse.asset({ glb: " QU\nJD " })?.glb).toBe("QUJD");
    expect(parse.glb("data:model/gltf-binary;base64,QUJD")).toBe("QUJD");
  });
});

describe("load.decodeGlb", () => {
  it("décode et applique le plafond", () => {
    expect(new Uint8Array(load.decodeGlb("QUJD"))).toEqual(
      new Uint8Array([65, 66, 67]),
    );
    expect(() => load.decodeGlb("QUJDQUJD", 3)).toThrow(/volumineux/);
    expect(() => load.decodeGlb("!!!!")).toThrow(/invalide/);
  });
  it("plafond dur 2 Mo même si max-glb-bytes est plus grand", () => {
    const big = "A".repeat(3 * 1024 * 1024);
    expect(() => load.decodeGlb(big, 10 * 1024 * 1024)).toThrow(/volumineux/);
  });
});

describe("asset.resolve glb", () => {
  it("priorité prop glb > src > DP, limite par défaut posée", () => {
    const a = asset.resolve(
      { asset: null, src: "https://x/y.glb", glb: "QUJD", maxGlbBytes: 99 },
      null,
    );
    expect(a?.glb).toBe("QUJD");
    expect(a?.maxBytes).toBe(99);
    const pub = { get: () => ({ glb: "QUJD" }) } as never;
    expect(asset.resolve({ asset: null, src: "" }, pub)?.glb).toBe("QUJD");
  });
});

describe("GLB embarqué (sans fetch)", () => {
  it("charge le plateau via parse, 67 noeuds nommés", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const root = new THREE.Group();
    const ctx = {
      root,
      content: null,
      bbox: new THREE.Box3(),
      blobUrl: null,
      loader: new GLTFLoader(),
      fitEnabled: false,
      fitToContent: () => {},
      highlighted: null,
      prevEmissive: new THREE.Color(),
      prevEmissiveIntensity: 0,
    } as unknown as LoadCtx;
    const res = await load.asset(
      ctx,
      { kind: "glb", glb: BOARD_GLB_B64, maxBytes: 512 * 1024 },
      1,
      () => true,
    );
    expect(res.ready).toBe(true);
    expect(ctx.content?.getObjectByName("m_10")).toBeTruthy();
    expect(ctx.content?.getObjectByName("hole_24")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("NodeOverrides", () => {
  it("déplace uniquement le nœud ciblé (patch)", () => {
    const root = scene();
    const n = new NodeOverrides();
    n.attach(root);
    n.apply({ m_10: { y: 1.5 } }, 0);
    expect(root.getObjectByName("m_10")!.position.y).toBe(1.5);
    expect(root.getObjectByName("m_11")!.position.y).toBe(0);
  });

  it("clone le matériau : la couleur de m_10 ne change pas m_11", () => {
    const root = scene();
    const n = new NodeOverrides();
    n.attach(root);
    n.apply({ m_10: { color: "#ff0000" } }, 0);
    const a = (root.getObjectByName("m_10") as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const b = (root.getObjectByName("m_11") as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(a.color.getHex()).toBe(0xff0000);
    expect(b.color.getHex()).toBe(0x00ff00);
  });

  it("nom inconnu : compté, sans exception", () => {
    const n = new NodeOverrides();
    n.attach(scene());
    n.apply({ nope: { y: 1 }, m_10: { y: 1 } }, 0);
    expect(n.missing).toBe(1);
  });

  it("ease + lift : arc au milieu, arrivée exacte", () => {
    const root = scene();
    const m = root.getObjectByName("m_10")!;
    const n = new NodeOverrides();
    n.attach(root);
    n.apply({ m_10: { x: 2, lift: 1, ease: { ms: 100, curve: "linear" } } }, 0);
    expect(m.position.x).toBe(0);
    n.step(50);
    expect(m.position.x).toBeCloseTo(1);
    expect(m.position.y).toBeCloseTo(1);
    n.step(100);
    expect(m.position.x).toBe(2);
    expect(m.position.y).toBeCloseTo(0);
    expect(n.active).toBe(false);
  });

  it("nouvel override repart de la valeur courante", () => {
    const root = scene();
    const m = root.getObjectByName("m_10")!;
    const n = new NodeOverrides();
    n.attach(root);
    n.apply({ m_10: { x: 10, ease: { ms: 100 } } }, 0);
    n.step(50);
    n.apply({ m_10: { x: 0, ease: { ms: 100 } } }, 50);
    n.step(100);
    expect(m.position.x).toBeCloseTo(2.5);
  });

  it("$reset restaure l'état du fichier et les matériaux", () => {
    const root = scene();
    const m = root.getObjectByName("m_10") as THREE.Mesh;
    const orig = m.material;
    const n = new NodeOverrides();
    n.attach(root);
    n.apply({ m_10: { y: 3, visible: false, color: "#fff" } }, 0);
    n.apply({ $reset: true }, 0);
    expect(m.position.y).toBe(0);
    expect(m.visible).toBe(true);
    expect(m.material).toBe(orig);
  });

  it("attach purge caches et tweens (rechargement)", () => {
    const n = new NodeOverrides();
    n.attach(scene());
    n.apply({ m_10: { x: 1, ease: { ms: 100 } } }, 0);
    expect(n.active).toBe(true);
    n.attach(scene());
    expect(n.active).toBe(false);
  });
});

describe("tap → store", () => {
  function host(over: Partial<PointerHost> = {}) {
    const hit = { x: 1, y: 2, z: 3, objectId: "m_10" };
    return {
      pointerX: 0,
      pointerY: 0,
      pick: true,
      target: "game",
      pickActionType: "pick",
      pickNames: "^(m_|hole_)",
      pickEmpty: false,
      tapStart: null,
      lastHit: null,
      hovering: false,
      runtime: { ready: true, pick: vi.fn(() => hit) },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect,
      dispatchEvent: () => true,
      syncPlayback: () => {},
      ...over,
    } as unknown as PointerHost;
  }
  const ev = (x: number, y: number) =>
    ({ button: 0, clientX: x, clientY: y }) as PointerEvent;

  it("tap envoie l'action, drag de 50 px n'envoie rien", () => {
    const got: unknown[] = [];
    registerStore({ id: "game", dispatch: (a) => got.push(a), getState: () => ({}), reset: () => {} });
    const h = host();
    pointer.onDown(h, ev(10, 10));
    pointer.onUp(h, ev(11, 10));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "pick", payload: { objectId: "m_10" } });
    pointer.onDown(h, ev(10, 10));
    pointer.onUp(h, ev(60, 10));
    expect(got).toHaveLength(1);
    unregisterStore("game");
  });

  it("pick-names filtre ; pick-empty envoie objectId null", () => {
    const got: any[] = [];
    registerStore({ id: "game", dispatch: (a) => got.push(a), getState: () => ({}), reset: () => {} });
    const h = host({ pickNames: "^hole_" });
    pointer.onDown(h, ev(0, 0));
    pointer.onUp(h, ev(0, 0));
    expect(got).toHaveLength(0);
    const h2 = host({ pickNames: "^hole_", pickEmpty: true });
    pointer.onDown(h2, ev(0, 0));
    pointer.onUp(h2, ev(0, 0));
    expect(got[0].payload).toEqual({ objectId: null });
    unregisterStore("game");
  });
});
