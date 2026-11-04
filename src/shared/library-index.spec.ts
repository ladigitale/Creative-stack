import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Entry = { id: string; kind: string; addon: string; version: number; sha256: string; source: string; params?: unknown[] };

function build(): { schema: string; entries: Entry[] } {
  const out = join(mkdtempSync(join(tmpdir(), "lib-")), "library.json");
  execFileSync("node", ["scripts/build-library.mjs"], { env: { ...process.env, LIBRARY_OUT: out }, stdio: "pipe" });
  return JSON.parse(readFileSync(out, "utf8"));
}

describe("dist/library.json (index consolidé pour Tadaaa)", () => {
  const lib = build();

  it("ids préfixés par l'addon, sources inline, empreinte du contenu", () => {
    expect(lib.schema).toBe("library/1");
    expect(lib.entries.length).toBeGreaterThanOrEqual(10);
    for (const e of lib.entries) {
      expect(e.id.startsWith(`${e.addon}/`)).toBe(true);
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.source.length).toBeGreaterThan(20);
      expect(e).not.toHaveProperty("file");
    }
    expect(lib.entries.find((e) => e.id === "shader/plasma")).toMatchObject({ kind: "shader", version: 1 });
  });

  it("trié par id, sans doublon", () => {
    const ids = lib.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
