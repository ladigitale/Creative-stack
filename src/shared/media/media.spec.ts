import { describe, expect, it } from "vitest";
import { captureError } from "./capture";
import { CounterTrigger } from "./control";
import { safeMediaUrl } from "./urls";

describe("captureError", () => {
  it("statuts et messages lisibles", () => {
    expect(captureError({ name: "NotAllowedError" }, "caméra")).toEqual({ status: "denied", error: "accès à la caméra refusé" });
    expect(captureError({ name: "NotAllowedError" }, "micro")).toEqual({ status: "denied", error: "accès au micro refusé" });
    expect(captureError({ name: "NotFoundError" }, "caméra").error).toBe("aucune caméra trouvée");
    expect(captureError({ name: "NotFoundError" }, "micro").error).toBe("aucun micro trouvé");
    expect(captureError({ name: "NotReadableError" }, "caméra").error).toContain("autre application");
    expect(captureError(new Error("boum"), "micro")).toEqual({ status: "error", error: "boum" });
  });
});

describe("safeMediaUrl", () => {
  it("https, relatif, blob, data du bon type", () => {
    for (const ok of ["https://x.org/a.webm", "clip.webm", "/v/a.mp4", "blob:https://x/1", "data:video/webm;base64,AA"]) {
      expect(safeMediaUrl(ok, "video"), ok).toBe(true);
    }
    for (const bad of ["http://x.org/a.webm", "javascript:alert(1)", "data:text/html,x", "data:audio/wav;base64,AA", "//evil.org/a.webm", "file:///a", ""]) {
      expect(safeMediaUrl(bad, "video"), bad).toBe(false);
    }
    expect(safeMediaUrl("data:audio/wav;base64,AA", "audio")).toBe(true);
  });
});

describe("CounterTrigger", () => {
  it("première valeur = référence, hausse = déclenchement, baisse = nouvelle référence", () => {
    const t = new CounterTrigger();
    expect([3, 4, 4, 5, 0, 1, { n: 2 }, "x", null].map((v) => t.feed(v))).toEqual([false, true, false, true, false, true, true, false, false]);
  });
});
