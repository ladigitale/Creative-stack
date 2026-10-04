/**
 * Environnement navigateur pour les tests (jsdom).
 *
 * 1) jsdom / Vitest n'exposent pas CompressionStream / DecompressionStream sur
 *    window — PublisherProxy s'appuie sur window.* (cache localStorage).
 *    On les importe depuis node:stream/web (fiable même en pool VM, où
 *    globalThis est le contexte jsdom et non le Node hôte).
 *
 * 2) PublisherManager.cleanStorageData() est lancé en fire-and-forget au
 *    constructeur. S'il reprend après le teardown jsdom → ReferenceError:
 *    window is not defined. On laisse finir microtasks / rAF après chaque test.
 */
import {
  CompressionStream as NodeCompressionStream,
  DecompressionStream as NodeDecompressionStream,
} from "node:stream/web";
import { afterEach } from "vitest";

const root = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis;
  CompressionStream?: unknown;
  DecompressionStream?: unknown;
};

function installStreamApis(target: {
  CompressionStream?: unknown;
  DecompressionStream?: unknown;
}) {
  if (!target.CompressionStream) {
    target.CompressionStream = NodeCompressionStream;
  }
  if (!target.DecompressionStream) {
    target.DecompressionStream = NodeDecompressionStream;
  }
}

installStreamApis(root);
if (root.window) {
  installStreamApis(
    root.window as typeof root.window & {
      CompressionStream?: unknown;
      DecompressionStream?: unknown;
    },
  );
}

afterEach(async () => {
  // Laisser aboutir cleanStorageData / requestAnimationFrame avant destruction de window.
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => done());
    } else {
      setTimeout(done, 0);
    }
  });
  await Promise.resolve();
});
