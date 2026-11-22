import { describe, expect, it } from "vitest";
import { morseNormalize } from "./morse";
import { FAST_START_EXTRA, FastDecoder, buildFastTable, defaultFastTable, fastPlan, fastSigns, fastSymbols, fastTimeline } from "./fastcode";

const table = defaultFastTable();

/** Rejoue une chronologie dans un décodeur, avec jitter et biais sur les durées mesurées. */
function replay(text: string, opts: { unit?: number; bias?: number; jitter?: (i: number) => number; start?: number; dec?: FastDecoder } = {}) {
  const unit = opts.unit ?? 300;
  const start = opts.start ?? 5;
  const dec = opts.dec ?? new FastDecoder(table);
  const steps = fastTimeline(text, unit, 0, start, table);
  const bias = opts.bias ?? 0;
  let result = "more";
  steps.forEach((s, i) => {
    const ms = s.ms + (s.on ? bias : -bias) + (opts.jitter?.(i) ?? 0);
    if (i === 0) dec.start(ms, start + FAST_START_EXTRA);
    else if (result === "more") result = dec.feed(s.on, ms);
  });
  return { dec, result };
}

describe("table de code", () => {
  it("le code est sans préfixe et couvre tous les symboles", () => {
    const strs = table.codes.map((c) => c.join(""));
    expect(strs.every(Boolean)).toBe(true);
    for (let i = 0; i < strs.length; i++) for (let j = 0; j < strs.length; j++) if (i !== j) expect(strs[j].startsWith(strs[i])).toBe(false);
  });

  it("coût moyen d'un caractère sous 6 unités (le morse : environ 8)", () => {
    expect(table.avgUnits).toBeLessThan(6);
  });

  it("les symboles fréquents sont courts : E, espace et OUI avant Z, K, W", () => {
    const cost = (id: number) => table.codes[id].reduce((a, k) => a + k, 0);
    const id = (t: string) => table.texts.indexOf(t);
    expect(cost(id("E"))).toBeLessThan(cost(id("Z")));
    expect(cost(id(" "))).toBeLessThan(cost(id("K")));
    expect(cost(table.phrases.get("OUI")!)).toBeLessThan(cost(id("W")));
  });

  it("table par défaut mise en cache, table personnalisée distincte", () => {
    expect(buildFastTable()).toBe(table);
    const custom = buildFastTable(["ALLO", "ZUT"]);
    expect(custom.hash).not.toBe(table.hash);
    expect(custom.phrases.has("ALLO")).toBe(true);
    expect(custom.phrases.has("OUI")).toBe(false);
  });

  it("phrases normalisées, doublons et caractères seuls écartés", () => {
    const custom = buildFastTable(["Ça va ?", "CA VA ?", "x", "€€", "ok"]);
    expect([...custom.phrases.keys()].sort()).toEqual(["CA VA ?", "OK"]);
  });
});

describe("symboles", () => {
  it("une phrase de la table est un seul symbole", () => {
    expect(fastSymbols("oui", table)).toEqual([table.phrases.get("OUI")]);
    expect(fastSymbols("Oui merci", table)).toEqual([table.phrases.get("OUI"), table.space, table.phrases.get("MERCI")]);
  });

  it("phrase de plusieurs mots, la plus longue d'abord", () => {
    expect(fastSymbols("ca va ?", table)).toEqual([table.phrases.get("CA VA ?")]);
    expect(fastSymbols("ca va", table)).toEqual([table.phrases.get("CA VA")]);
  });

  it("hors table : caractère par caractère", () => {
    const ids = fastSymbols("zoo", table);
    expect(ids.map((i) => table.texts[i]).join("")).toBe("ZOO");
  });
});

describe("émission et réception", () => {
  const messages = ["oui", "salut ca va ?", "je suis devant la porte", "RDV 18h30, parking (nord) !", "a", "73", "x y z", "tout va bien merci a bientot"];

  it.each(messages)("aller-retour exact : %s", (m) => {
    const { dec, result } = replay(m);
    expect(result).toBe("done");
    expect(dec.ok).toBe(true);
    expect(dec.text).toBe(morseNormalize(m));
  });

  it("le dernier intervalle est toujours un éclat (front de fin)", () => {
    for (const m of messages) {
      const steps = fastTimeline(m, 100, 0, 5, table);
      expect(steps[steps.length - 1].on).toBe(true);
    }
  });

  it("chronologie : éclat de début, silence de 3 unités, intervalles alternés", () => {
    const steps = fastTimeline("oui", 100, 0, 5, table);
    expect(steps[0]).toMatchObject({ on: true, ms: 700 });
    expect(steps[1]).toMatchObject({ on: false, ms: 300 });
    steps.slice(2).forEach((s, i) => {
      expect(s.on).toBe(i % 2 === 0);
      expect([100, 200, 300]).toContain(s.ms);
    });
    expect(fastTimeline("", 100)).toEqual([]);
    expect(fastTimeline("€", 100)).toEqual([]);
  });

  it("avancement : tous les caractères comptés à la fin", () => {
    const steps = fastTimeline("oui merci", 100, 0, 5, table);
    expect(steps[0].chars).toBe(0);
    expect(steps[steps.length - 1].chars).toBe(9);
    for (let i = 1; i < steps.length; i++) expect(steps[i].chars).toBeGreaterThanOrEqual(steps[i - 1].chars);
  });

  it("trim : éclats raccourcis, silences allongés (le dernier éclat n'a pas de silence après lui)", () => {
    const sum = (s: { ms: number }[]) => s.reduce((a, x) => a + x.ms, 0);
    const plain = fastTimeline("salut", 300, 0, 5, table);
    const trimmed = fastTimeline("salut", 300, 40, 5, table);
    expect(sum(plain) - sum(trimmed)).toBe(40);
    expect(trimmed[0].ms).toBe(2060);
    expect(trimmed[1].ms).toBe(940);
  });

  it("tolère un biais constant de 50 ms (éclats allongés) et un jitter de ±40 ms", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (const m of messages) {
      const { dec, result } = replay(m, { bias: 50, jitter: () => rnd() * 40 });
      expect(result).toBe("done");
      expect(dec.text).toBe(morseNormalize(m));
    }
  });

  it("suit un émetteur d'une autre unité : l'étalonnage vient de l'éclat de début", () => {
    const dec = new FastDecoder(table);
    const steps = fastTimeline("bonjour a toi", 200, 0, 5, table);
    steps.forEach((s, i) => (i === 0 ? dec.start(s.ms, 7) : dec.feed(s.on, s.ms)));
    expect(dec.ok).toBe(true);
    expect(Math.round(dec.unit)).toBe(200);
  });

  it("un intervalle mal lu est rejeté par le contrôle ou le code, jamais pris pour un autre message", () => {
    let bad = 0;
    let wrong = 0;
    const m = "je suis devant la porte";
    const n = fastTimeline(m, 300, 0, 5, table).length;
    for (let hit = 2; hit < n; hit++) {
      const dec = new FastDecoder(table);
      const steps = fastTimeline(m, 300, 0, 5, table);
      let r = "more";
      steps.forEach((s, i) => {
        if (i === 0) dec.start(s.ms, 7);
        else if (r === "more") r = dec.feed(s.on, i === hit ? (s.ms > 450 ? s.ms - 300 : s.ms + 300) : s.ms);
      });
      if (r === "done") wrong += dec.text === morseNormalize(m) ? 0 : 1;
      else bad++;
    }
    // Au plus un message erroné accepté sur 27 en moyenne ; ici sur une centaine de fautes simulées.
    expect(wrong).toBeLessThanOrEqual(Math.ceil((n - 2) / 27) + 1);
    expect(bad).toBeGreaterThan(n * 0.8);
  });

  it("une autre table de phrases : message rejeté", () => {
    const other = buildFastTable(["OUI", "ALLO", "ZUT"]);
    const dec = new FastDecoder(other);
    const steps = fastTimeline("tout va bien", 300, 0, 5, table);
    let r = "more";
    steps.forEach((s, i) => {
      if (i === 0) dec.start(s.ms, 7);
      else if (r === "more") r = dec.feed(s.on, s.ms);
    });
    expect(r).not.toBe("done");
  });

  it("étalonnage invalide : un silence trop court ou trop long après l'éclat de début est rejeté", () => {
    for (const gap of [200, 2000]) {
      const dec = new FastDecoder(table);
      dec.start(2100, 7);
      expect(dec.feed(false, gap)).toBe("error");
      expect(dec.error).toBe("étalonnage");
    }
  });

  it("alternance rompue (front manqué) : rejeté", () => {
    const dec = new FastDecoder(table);
    dec.start(2100, 7);
    dec.feed(false, 900);
    expect(dec.feed(false, 300)).toBe("error");
    expect(dec.error).toBe("alternance");
  });

  it("signes : durées en chiffres", () => {
    expect(fastSigns("oui", table)).toMatch(/^[123]+$/);
    expect(fastSigns("oui", table).length).toBe(fastPlan("oui", table).intervals.length);
  });
});

describe("gain sur le morse", () => {
  it("une phrase de la table va presque deux fois plus vite, attente de fin du morse comprise", async () => {
    const { morseTimeline } = await import("./morse");
    const sum = (s: { ms: number }[]) => s.reduce((a, x) => a + x.ms, 0);
    for (const m of ["merci", "salut ca va ?", "j'arrive"]) {
      const morse = sum(morseTimeline(m, 300, 0, 5)) + 12 * 300;
      expect(morse / sum(fastTimeline(m, 300, 0, 5, table))).toBeGreaterThan(1.8);
    }
  });
});

describe("identifiant de l'émetteur", () => {
  const roster = ["Renard", "Loup", "Aigle"];
  const t = buildFastTable(undefined, roster);
  const play = (text: string, speaker: string, dec = new FastDecoder(t)) => {
    const steps = fastTimeline(text, 300, 0, 5, t, speaker);
    let r = "more";
    steps.forEach((s, i) => (i === 0 ? dec.start(s.ms, 7) : r === "more" ? (r = dec.feed(s.on, s.ms)) : 0));
    return { dec, r };
  };

  it("le pseudo fait l'aller-retour avec le message", () => {
    for (const who of roster) {
      const { dec, r } = play("je suis la", who);
      expect(r).toBe("done");
      expect(dec.text).toBe("JE SUIS LA");
      expect(dec.speaker).toBe(who.toUpperCase());
    }
  });

  it("pseudo inconnu ou absent : anonyme, message reçu", () => {
    for (const who of ["", "Ours"]) {
      const { dec, r } = play("merci", who);
      expect(r).toBe("done");
      expect(dec.speaker).toBe("");
    }
  });

  it("deux intervalles de plus pour jusqu'à 8 pseudos, trois au-delà (± l'éclat de fermeture)", () => {
    const base = fastPlan("merci", t).intervals.length; // identifiant 0 : en-tête déjà compté
    expect(fastPlan("merci", t, "loup").intervals.length).toBe(base);
    const none = fastPlan("merci").intervals.length;
    expect(base - none).toBeGreaterThanOrEqual(2);
    expect(base - none).toBeLessThanOrEqual(3);
    const big = buildFastTable(undefined, Array.from({ length: 12 }, (_, i) => `P${i}`));
    expect(fastPlan("merci", big, "p11").intervals.length - none).toBeGreaterThanOrEqual(3);
  });

  it("un autre pseudo dans l'en-tête est rejeté (le contrôle couvre l'identité)", () => {
    const steps = fastTimeline("merci", 300, 0, 5, t, "Loup");
    const forged = fastTimeline("merci", 300, 0, 5, t, "Aigle");
    expect(forged[2].ms === steps[2].ms && forged[3].ms === steps[3].ms).toBe(false);
    const dec = new FastDecoder(t);
    let r = "more";
    const mix = steps.map((s, i) => (i === 2 || i === 3 ? forged[i] : s));
    mix.forEach((s, i) => (i === 0 ? dec.start(s.ms, 7) : r === "more" ? (r = dec.feed(s.on, s.ms)) : 0));
    expect(r).toBe("error");
  });

  it("sans liste, rien ne change", () => {
    expect(fastPlan("merci", defaultFastTable(), "loup").intervals).toEqual(fastPlan("merci").intervals);
  });
});
