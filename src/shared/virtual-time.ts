/**
 * Horloge virtuelle de la page, pour un rendu hors temps réel (même principe que CCapture.js).
 *
 * Une fois installée, `requestAnimationFrame` / `cancelAnimationFrame`, `performance.now` et
 * `Date.now` sont remplacés : les rappels rAF sont mis en file et ne s'exécutent qu'à `advance(ms)`,
 * avec l'horodatage virtuel ; le temps ne bouge que par `advance`. Les composants qui prennent leur
 * temps de `performance.now()` ou du timestamp de rAF avancent donc au pas voulu sans modification.
 *
 * Non virtualisés : `setTimeout` / `setInterval`, `new Date()` (sans argument), le temps des
 * `<video>`, de la caméra, du son (AudioContext.currentTime), des animations et transitions CSS.
 *
 * Une seule horloge à la fois par page. `restore()` remet toujours les fonctions d'origine
 * (idempotent) ; les rappels encore en file sont confiés au vrai `requestAnimationFrame` pour que
 * les boucles d'animation continuent après la capture.
 */

type RafCallback = (t: number) => void;

export type RealTime = {
  raf: (cb: RafCallback) => number;
  caf: (id: number) => void;
  now: () => number;
  dateNow: () => number;
};

export type VirtualClock = {
  /** Vrai tant que les fonctions de la page sont remplacées. */
  readonly installed: boolean;
  /** Vrai une fois le temps figé (`freeze` ou premier `advance`). */
  readonly frozen: boolean;
  /** Rappels rAF en attente. */
  readonly pending: number;
  /** Temps virtuel (référence `performance.now`, ms). */
  now(): number;
  /**
   * Fige le temps à `at` (défaut : l'instant réel). Avant, `performance.now` / `Date.now` suivent
   * le temps réel (seuls les rAF sont retenus).
   */
  freeze(at?: number): void;
  /** Avance le temps de `ms`, puis exécute les rappels rAF en attente. Retourne leur nombre. */
  advance(ms: number): number;
  /**
   * Comme `advance`, jusqu'à l'instant `at` (jamais en arrière) : à préférer pour un pas fixe,
   * `t0 + n / fps` ne cumule pas d'erreur d'arrondi.
   */
  advanceTo(at: number): number;
  /** Remet les fonctions d'origine. */
  restore(): void;
  /** Fonctions réelles (sauvegardées à l'installation). */
  readonly real: RealTime;
};

type Saved = { obj: object; key: string; desc: PropertyDescriptor | undefined };

/** Ids des rAF virtuels : loin des ids réels (petits entiers), un vrai `cancelAnimationFrame` les ignore. */
const ID_BASE = 2 ** 30;

let current: VirtualClock | null = null;

/** Horloge installée, ou null. */
export function activeVirtualClock(): VirtualClock | null {
  return current?.installed ? current : null;
}

function realFunctions(): RealTime {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: RafCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const perf = globalThis.performance;
  const raf = typeof g.requestAnimationFrame === "function"
    ? g.requestAnimationFrame.bind(globalThis)
    : (cb: RafCallback) => setTimeout(() => cb(perf.now()), 16) as unknown as number;
  const caf = typeof g.cancelAnimationFrame === "function"
    ? g.cancelAnimationFrame.bind(globalThis)
    : (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  return { raf, caf, now: perf.now.bind(perf), dateNow: Date.now.bind(Date) };
}

function save(obj: object, key: string): Saved {
  return { obj, key, desc: Object.getOwnPropertyDescriptor(obj, key) };
}

function put(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: true });
}

function putBack(s: Saved): void {
  try {
    if (s.desc) Object.defineProperty(s.obj, s.key, s.desc);
    else delete (s.obj as Record<string, unknown>)[s.key];
  } catch {
    /* propriété figée par un tiers : rien de mieux à faire */
  }
}

function report(e: unknown): void {
  const g = globalThis as unknown as { reportError?: (e: unknown) => void };
  if (typeof g.reportError === "function") g.reportError(e);
  else console.error(e);
}

/**
 * Installe l'horloge virtuelle. Lève une erreur si une autre est déjà installée
 * (une seule capture hors temps réel à la fois).
 */
export function installVirtualTime(): VirtualClock {
  if (activeVirtualClock()) throw new Error("une capture hors temps réel est déjà en cours dans la page");
  const real = realFunctions();
  const saved = [
    save(globalThis, "requestAnimationFrame"),
    save(globalThis, "cancelAnimationFrame"),
    save(globalThis.performance, "now"),
    save(Date, "now"),
  ];
  let installed = true;
  let frozen = false;
  let vNow = 0;
  let dateOffset = 0;
  let seq = ID_BASE;
  let queue = new Map<number, RafCallback>();

  const now = () => (frozen ? vNow : real.now());
  const freeze = (at = real.now()) => {
    if (frozen) return;
    frozen = true;
    vNow = at;
    dateOffset = real.dateNow() - real.now();
  };

  put(globalThis, "requestAnimationFrame", (cb: RafCallback) => {
    if (typeof cb !== "function") throw new TypeError("requestAnimationFrame : rappel attendu");
    const id = ++seq;
    queue.set(id, cb);
    return id;
  });
  put(globalThis, "cancelAnimationFrame", (id: number) => {
    if (!queue.delete(id)) real.caf(id);
  });
  put(globalThis.performance, "now", () => now());
  put(Date, "now", () => (frozen ? Math.floor(vNow + dateOffset) : real.dateNow()));

  const clock: VirtualClock = {
    get installed() {
      return installed;
    },
    get frozen() {
      return frozen;
    },
    get pending() {
      return queue.size;
    },
    now,
    freeze,
    advance(ms: number): number {
      freeze();
      return clock.advanceTo(vNow + (Number.isFinite(ms) && ms > 0 ? ms : 0));
    },
    advanceTo(at: number): number {
      if (!installed) return 0;
      freeze();
      if (Number.isFinite(at) && at > vNow) vNow = at;
      // Rappels demandés pendant ce pas : pour le pas suivant (comme un vrai rafraîchissement).
      const batch = queue;
      queue = new Map();
      const t = vNow;
      for (const cb of batch.values()) {
        try {
          cb(t);
        } catch (e) {
          report(e);
        }
      }
      return batch.size;
    },
    restore(): void {
      if (!installed) return;
      installed = false;
      for (const s of saved) putBack(s);
      if (current === clock) current = null;
      // Les boucles en attente repartent au vrai rythme.
      const left = [...queue.values()];
      queue = new Map();
      if (left.length) {
        real.raf((t) => {
          for (const cb of left) {
            try {
              cb(t);
            } catch (e) {
              report(e);
            }
          }
        });
      }
    },
    real,
  };
  current = clock;
  return clock;
}

/** Prochain vrai rafraîchissement (timestamp), ou au plus tard `maxMs` (onglet masqué : rAF suspendu). */
export function nextRealFrame(real: RealTime, maxMs = 100): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (t: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      real.caf(id);
      resolve(t);
    };
    const timer = setTimeout(() => finish(real.now()), maxMs);
    const id = real.raf((t) => finish(t));
  });
}

/** Une tâche (macrotâche) : toutes les microtâches en attente (mises à jour Lit, promesses) sont passées. */
export function nextTask(): Promise<void> {
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
