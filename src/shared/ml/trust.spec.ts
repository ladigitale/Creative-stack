import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  configureMl,
  decideTrust,
  getMlPolicy,
  matchesOrigin,
  normalizeOrigins,
  parseModelRef,
  readConsentValue,
  resetMlConfig,
} from "./trust";

afterEach(() => resetMlConfig());

describe("parseModelRef", () => {
  it("alias connu", () => {
    const r = parseModelRef("hand-landmarker", DEFAULT_POLICY.aliases);
    expect(r).toMatchObject({ kind: "alias", alias: "hand-landmarker" });
  });
  it("refuse http, data:, identifiants, texte quelconque", () => {
    expect(parseModelRef("http://x.org/m.task", {})).toMatchObject({ error: "insecure-url" });
    expect(parseModelRef("data:application/octet-stream;base64,AA==", {})).toMatchObject({ error: "insecure-url" });
    expect(parseModelRef("https://u:p@x.org/m.task", {})).toMatchObject({ error: "invalid-model" });
    expect(parseModelRef("mon-modele", {})).toMatchObject({ error: "invalid-model" });
    expect(parseModelRef("", {})).toMatchObject({ error: "invalid-model" });
  });
});

describe("matchesOrigin", () => {
  it("préfixe de chemin, pas de sous-domaine déguisé ni de remontée", () => {
    expect(matchesOrigin("https://a.org/m/x.task", "https://a.org/m/")).toBe(true);
    expect(matchesOrigin("https://a.org/m", "https://a.org/m")).toBe(true);
    expect(matchesOrigin("https://a.org/mx/x.task", "https://a.org/m/")).toBe(false);
    expect(matchesOrigin("https://a.org.evil.com/m/x", "https://a.org/m/")).toBe(false);
    expect(matchesOrigin("https://a.org/m/../x.task", "https://a.org/m/")).toBe(false);
  });
});

describe("decideTrust", () => {
  it("alias : autorisé sans consentement", () => {
    const d = decideTrust("hand-landmarker", getMlPolicy());
    expect(d).toMatchObject({ allowed: true, needsConsent: false });
  });
  it("origine approuvée : consentement par origine", () => {
    const d = decideTrust("https://huggingface.co/x/y/resolve/main/m.task", getMlPolicy());
    expect(d).toMatchObject({ allowed: true, needsConsent: true, consentKey: "origin:https://huggingface.co" });
  });
  it("origine inconnue refusée au niveau origins", () => {
    expect(decideTrust("https://autre.org/m.task", getMlPolicy())).toMatchObject({
      allowed: false,
      code: "origin-not-allowed",
    });
  });
  it("niveau open : consentement par modèle", () => {
    configureMl({ level: "open" });
    expect(decideTrust("https://autre.org/m.task", getMlPolicy())).toMatchObject({
      allowed: true,
      needsConsent: true,
      consentKey: "url:https://autre.org/m.task",
    });
  });
  it("configureMl complète ou remplace les origines", () => {
    configureMl({ origins: ["https://autre.org/models/", "http://nope.org/", 3 as never] });
    expect(getMlPolicy().origins).toContain("https://autre.org/models/");
    expect(getMlPolicy().origins).not.toContain("http://nope.org/");
    expect(decideTrust("https://autre.org/models/m.task", getMlPolicy())).toMatchObject({ allowed: true });
    configureMl({ origins: ["https://seul.org/"], replaceOrigins: true });
    expect(getMlPolicy().origins).toEqual(["https://seul.org/"]);
  });
});

describe("divers", () => {
  it("normalizeOrigins ignore le non-https", () => {
    expect(normalizeOrigins(["https://a.org/x/", "ftp://b.org/", 1, null])).toEqual(["https://a.org/x/"]);
    expect(normalizeOrigins("x")).toEqual([]);
  });
  it("readConsentValue", () => {
    expect(readConsentValue(true)).toBe("accepted");
    expect(readConsentValue("accepted")).toBe("accepted");
    expect(readConsentValue("declined")).toBe("declined");
    expect(readConsentValue(undefined)).toBeNull();
  });
});
