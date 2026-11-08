import { afterEach, describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicKeyboard, readKeyboardParams, readKeymap, readRepeat } from "./keyboard";

void SonicKeyboard;

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(attrs: Record<string, string>) {
  const el = document.createElement("sonic-keyboard") as SonicKeyboard;
  el.dispatchEventFlag = true;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  const got: Array<{ type: string; payload?: unknown }> = [];
  el.addEventListener("sonic-action", (e) => got.push((e as CustomEvent).detail));
  return { el, got };
}

const key = (type: "keydown" | "keyup", code: string) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));

describe("lecture des réglages", () => {
  it("keymap : objet ou JSON, entrées invalides écartées", () => {
    expect(readKeymap('{"KeyA":"left","KeyB":{"type":"fire","payload":2},"KeyC":3,"KeyD":{"type":""}}')).toEqual({ KeyA: "left", KeyB: { type: "fire", payload: 2 } });
    expect(readKeymap("pas du json")).toBeNull();
    expect(readKeymap([1])).toBeNull();
  });
  it("repeat : durées bornées", () => {
    expect(readRepeat({ left: [-10, 1e9], bad: [1], x: ["a", 2] })).toEqual({ left: [0, 60000] });
  });
  it("params : clés refusées listées", () => {
    const r = readKeyboardParams({ keymap: 5, keyup: "oui", disabled: true });
    expect(r.invalid).toEqual(["keymap", "keyup"]);
    expect(r.settings).toEqual({ disabled: true });
  });
});

describe("sonic-keyboard", () => {
  it("out-data-provider : status, touches tenues, dernière action", async () => {
    const { got } = await mount({ keymap: '{"ArrowLeft":"left","Space":{"type":"jump","payload":1}}', keyup: "", "out-data-provider": "kb1" });
    const state = () => dp("kb1").get() as any;
    expect(state()).toMatchObject({ status: "ready", error: null, held: [], last: null, count: 0, keys: ["ArrowLeft", "Space"] });
    key("keydown", "ArrowLeft");
    key("keydown", "Space");
    expect(state().held).toEqual(["ArrowLeft", "Space"]);
    expect(state().last).toEqual({ code: "Space", type: "jump", payload: 1, phase: "down" });
    key("keyup", "ArrowLeft");
    expect(state().held).toEqual(["Space"]);
    expect(state().last).toMatchObject({ code: "ArrowLeft", type: "left:up", phase: "up" });
    expect(state().count).toBe(3);
    expect(got.map((a) => a.type)).toEqual(["left", "jump", "left:up"]);
  });

  it("keymap par params (prioritaire), par control ; clé retirée = retour à l'attribut", async () => {
    const { el, got } = await mount({ keymap: '{"KeyA":"a"}', params: "kb2p", control: "kb2c", "out-data-provider": "kb2" });
    set("kb2c", { keymap: { KeyA: "fromControl" } });
    key("keydown", "KeyA");
    key("keyup", "KeyA");
    set("kb2p", { keymap: { KeyA: "fromParams", KeyB: "b" } });
    key("keydown", "KeyA");
    key("keyup", "KeyA");
    expect((dp("kb2").get() as any).keys).toEqual(["KeyA", "KeyB"]);
    set("kb2p", {});
    set("kb2c", {});
    key("keydown", "KeyA");
    key("keyup", "KeyA");
    expect(got.map((a) => a.type)).toEqual(["fromControl", "fromParams", "a"]);
    expect(el.settings().keymap).toEqual({ KeyA: "a" });
  });

  it("disabled par params : plus d'action, status idle ; valeur refusée : status error", async () => {
    const { got } = await mount({ keymap: '{"KeyA":"a"}', params: "kb3p", "out-data-provider": "kb3" });
    set("kb3p", { disabled: true });
    key("keydown", "KeyA");
    expect(got).toEqual([]);
    expect((dp("kb3").get() as any).status).toBe("idle");
    set("kb3p", { keymap: "{oups" });
    expect((dp("kb3").get() as any)).toMatchObject({ status: "error" });
    expect((dp("kb3").get() as any).error).toContain("params.keymap");
  });
});
