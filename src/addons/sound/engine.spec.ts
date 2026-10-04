import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SoundEngine } from "./engine";
import { AudioEngine } from "../../shared/audio/engine";
import { FakeAudioContext } from "./fake-audio";
import type { SoundState } from "./types";
import "./sound";
import type { SonicSound } from "./sound";
import example from "./examples/neon-run.bank.json";

const engines: SoundEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.destroy();
  AudioEngine.reset();
  AudioEngine.setContextFactory(null);
  document.body.innerHTML = "";
});

async function makeEngine(unlock = true) {
  const ac = new FakeAudioContext();
  let state: SoundState | null = null;
  AudioEngine.setContextFactory(() => ac as unknown as BaseAudioContext);
  const engine = new SoundEngine({
    id: "t",
    onState: (s) => (state = s),
  });
  engines.push(engine);
  engine.setBank(example);
  if (unlock) await engine.unlock();
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    return state!;
  };
  return { ac, engine, flush };
}

describe("SoundEngine", () => {
  it("partage le contexte et le master de l'AudioEngine", async () => {
    const { ac, engine } = await makeEngine();
    const other = new SoundEngine({ id: "u" });
    engines.push(other);
    expect(engine.context).toBe(ac);
    expect(other.context).toBe(ac);
    expect(AudioEngine.get().context).toBe(ac);
  });

  it("rien ne joue avant le déverrouillage ; la musique demandée démarre ensuite", async () => {
    const { ac, engine, flush } = await makeEngine(false);
    engine.applyControl({ music: "theme" });
    expect(engine.play("coin")).toBe(false);
    let s = await flush();
    expect(s.unlocked).toBe(false);
    expect(s.music.id).toBe("theme");
    expect(s.music.playing).toBe(false);

    await engine.unlock();
    s = await flush();
    expect(s.unlocked).toBe(true);
    expect(s.music.playing).toBe(true);
    expect(ac.sources.length).toBeGreaterThan(0); // premières notes programmées
  });

  it("compteurs : la première valeur sert de référence, chaque hausse joue", async () => {
    const { engine, flush } = await makeEngine();
    engine.applyControl({ play: { coin: 3 } });
    expect((await flush()).played.coin).toBeUndefined();
    engine.applyControl({ play: { coin: 4 } });
    expect((await flush()).played.coin).toBe(1);
    engine.applyControl({ play: { coin: 4 } });
    expect((await flush()).played.coin).toBe(1);
    // remise à zéro du compteur : nouvelle référence, pas de son
    engine.applyControl({ play: { coin: 0 } });
    expect((await flush()).played.coin).toBe(1);
    await new Promise((r) => setTimeout(r, 40)); // cooldown
    engine.applyControl({ play: { coin: { n: 1, pitch: 5 } } });
    const s = await flush();
    expect(s.played.coin).toBe(2);
    expect(s.lastSfx?.id).toBe("coin");
  });

  it("presets jouables sans déclaration, bus ui séparé", async () => {
    const { engine, flush } = await makeEngine();
    expect(engine.play("click")).toBe(true);
    expect(engine.play("laser")).toBe(true);
    const s = await flush();
    expect(s.lastUi?.id).toBe("click");
    expect(s.lastSfx?.id).toBe("laser");
  });

  it("cooldown anti-spam", async () => {
    const { engine } = await makeEngine();
    expect(engine.play("jump")).toBe(true);
    expect(engine.play("jump")).toBe(false);
  });

  it("son ou morceau inconnu : erreur publiée", async () => {
    const { engine, flush } = await makeEngine();
    engine.applyControl({ music: "nope", play: { zzz: 1 } });
    engine.applyControl({ music: "nope", play: { zzz: 2 } });
    const s = await flush();
    expect(s.errors).toEqual(
      expect.arrayContaining(['music : morceau inconnu "nope"', 'play : son inconnu "zzz"']),
    );
  });

  it("muet : volume master à 0 et aucun son", async () => {
    const { ac, engine, flush } = await makeEngine();
    engine.applyControl({ muted: true, volume: { master: 0.5 } });
    expect(engine.play("coin")).toBe(false);
    expect((await flush()).muted).toBe(true);
    const master = ac.gains[1]; // gains[0] = master de l'AudioEngine, gains[1] = master du son
    expect(master.gain.value).toBe(0);
    engine.applyControl({ muted: false });
    expect(master.gain.value).toBe(0.5);
  });

  it("changement de musique : fondu et nouvel état", async () => {
    const { engine, flush } = await makeEngine();
    engine.applyControl({ music: "theme" });
    expect((await flush()).music.id).toBe("theme");
    engine.applyControl({ music: "boss", fade: 0.3 });
    let s = await flush();
    expect(s.music.id).toBe("boss");
    expect(s.music.bpm).toBe(150);
    engine.applyControl({ music: null });
    s = await flush();
    expect(s.music).toMatchObject({ id: null, playing: false, bpm: 0 });
  });

  it("polyphonie : voix comptées et libérées", async () => {
    const { ac, engine, flush } = await makeEngine();
    engine.play("explosion");
    expect((await flush()).voices).toBeGreaterThan(0);
    ac.advance(5);
    expect((await flush()).voices).toBe(0);
  });
});

describe("sonic-sound", () => {
  it("lit banque et pilotage par DataProvider, publie l'état", async () => {
    set("bankDp", example);
    set("game", { sound: { music: "theme", play: { coin: 0 } } });
    const el = document.createElement("sonic-sound") as SonicSound;
    el.setAttribute("bank-provider", "bankDp");
    el.setAttribute("control", "game.sound");
    el.setAttribute("out-data-provider", "out");
    document.body.appendChild(el);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    let out = JSON.parse(JSON.stringify(get("out"))) as SoundState;
    expect(out.songs).toEqual(["theme", "boss", "win", "lose"]);
    expect(out.music.id).toBe("theme");
    expect(out.supported).toBe(false); // jsdom : pas de WebAudio

    set("game", { sound: { music: "boss" } });
    await new Promise((r) => setTimeout(r, 0));
    out = JSON.parse(JSON.stringify(get("out")));
    expect(out.music.id).toBe("boss");
    el.remove();
  });
});
