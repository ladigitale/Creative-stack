import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./engine";

describe("AudioEngine.loadWorklets", () => {
  afterEach(() => vi.useRealTimers());

  it("repli natif quand le chargement ne répond pas", async () => {
    vi.useFakeTimers();
    const engine = AudioEngine.get() as unknown as { ac: unknown; loadWorklets(): Promise<boolean>; workletState: string; workletError: string | null };
    const ctx = { audioWorklet: { addModule: () => new Promise(() => {}) } };
    Object.defineProperty(engine, "ac", { value: ctx, configurable: true, writable: true });
    AudioEngine.setWorkletUrl("https://example.test/processors.js");
    const p = engine.loadWorklets();
    expect(engine.workletState).toBe("loading");
    await vi.advanceTimersByTimeAsync(AudioEngine.workletTimeoutMs + 10);
    await expect(p).resolves.toBe(false);
    expect(engine.workletState).toBe("failed");
    expect(engine.workletError).toContain("pas de réponse");
  });
});
