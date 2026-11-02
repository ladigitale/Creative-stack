import { describe, expect, it, vi } from "vitest";
import { fetchModel, ModelFetchError, normalizeSha256, sha256Hex } from "./model-fetch";

const bytes = new Uint8Array([1, 2, 3, 4, 5]);

function response(data: Uint8Array, init: { status?: number; length?: string | null; chunks?: number } = {}): Response {
  const chunks = init.chunks ?? 2;
  const size = Math.ceil(data.length / chunks);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < data.length; i += size) c.enqueue(data.slice(i, i + size));
      c.close();
    },
  });
  const headers: Record<string, string> = {};
  if (init.length !== null) headers["content-length"] = init.length ?? String(data.length);
  return new Response(stream, { status: init.status ?? 200, headers });
}

describe("fetchModel", () => {
  it("assemble les morceaux et publie la progression", async () => {
    const onProgress = vi.fn();
    const out = await fetchModel("https://m.example/a.task", {
      maxBytes: 100,
      onProgress,
      fetchImpl: async () => response(bytes, { chunks: 3 }),
    });
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 5, total: 5 });
  });

  it("refuse un modèle trop gros, avant ou pendant le téléchargement", async () => {
    await expect(
      fetchModel("https://m.example/a", { maxBytes: 3, fetchImpl: async () => response(bytes) }),
    ).rejects.toMatchObject({ code: "too-large" });
    await expect(
      fetchModel("https://m.example/a", { maxBytes: 3, fetchImpl: async () => response(bytes, { length: null }) }),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("vérifie l'empreinte sha256", async () => {
    const good = await sha256Hex(bytes);
    const ok = await fetchModel("https://m.example/a", { maxBytes: 100, sha256: `sha256-${good}`, fetchImpl: async () => response(bytes) });
    expect(ok.byteLength).toBe(5);
    await expect(
      fetchModel("https://m.example/a", { maxBytes: 100, sha256: "0".repeat(64), fetchImpl: async () => response(bytes) }),
    ).rejects.toMatchObject({ code: "hash-mismatch" });
    await expect(
      fetchModel("https://m.example/a", { maxBytes: 100, sha256: "xyz", fetchImpl: async () => response(bytes) }),
    ).rejects.toMatchObject({ code: "invalid-hash" });
  });

  it("HTTP en erreur ou réseau coupé : download-failed", async () => {
    await expect(
      fetchModel("https://m.example/a", { maxBytes: 100, fetchImpl: async () => response(bytes, { status: 404 }) }),
    ).rejects.toBeInstanceOf(ModelFetchError);
    await expect(
      fetchModel("https://m.example/a", { maxBytes: 100, fetchImpl: async () => Promise.reject(new Error("offline")) }),
    ).rejects.toMatchObject({ code: "download-failed" });
  });

  it("normalizeSha256", () => {
    expect(normalizeSha256("SHA256:" + "A".repeat(64))).toBe("a".repeat(64));
    expect(normalizeSha256("abc")).toBeNull();
  });
});
