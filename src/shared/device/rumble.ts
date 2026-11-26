/**
 * Vibration des manettes (API Gamepad), partagée par `sonic-gamepad` et `sonic-controller`.
 * `vibrationActuator.playEffect("dual-rumble", …)` (Chromium, Firefox récent), sinon
 * `hapticActuators[0].pulse(force, durée)` (ancien Firefox, WebXR). Non testé sur matériel.
 */

export type RumbleArgs = {
  /** Durée en ms (1..5000). */
  duration: number;
  /** Moteur lourd 0..1. */
  strong: number;
  /** Moteur léger 0..1. */
  weak: number;
  /** Index de la manette (Gamepad.index), `undefined` : laissé au composant. */
  pad: number | undefined;
};

export type RumbleState = { supported: boolean; active: boolean };

type Actuator = {
  playEffect?: (type: string, params: Record<string, number>) => Promise<unknown>;
  reset?: () => Promise<unknown>;
  effects?: string[];
};
type Haptic = { pulse?: (value: number, duration: number) => Promise<unknown> };
type PadLike = Gamepad & { vibrationActuator?: Actuator | null; hapticActuators?: readonly Haptic[] };

const clamp01 = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
};

/** Lit les arguments d'une commande `rumble` : `{n, duration | ms, strong, weak, pad}` (valeurs bornées). */
export function readRumble(arg: unknown): RumbleArgs {
  const a = (arg && typeof arg === "object" ? arg : {}) as Record<string, unknown>;
  const d = Number(a.duration ?? a.ms);
  const p = a.pad;
  const pad = p === undefined || p === null || p === "" ? undefined : Number(p);
  return {
    duration: Number.isFinite(d) && d > 0 ? Math.min(5000, Math.round(d)) : 200,
    strong: clamp01(a.strong, 0.8),
    weak: clamp01(a.weak, 0.5),
    pad: pad !== undefined && Number.isInteger(pad) && pad >= 0 ? pad : undefined,
  };
}

/** Vrai si la manette sait vibrer (actionneur double ou haptique). */
export function canRumble(pad: Gamepad | null | undefined): boolean {
  const p = pad as PadLike | null | undefined;
  if (!p) return false;
  const act = p.vibrationActuator;
  if (act && typeof act.playEffect === "function") {
    return !Array.isArray(act.effects) || act.effects.includes("dual-rumble");
  }
  return typeof p.hapticActuators?.[0]?.pulse === "function";
}

/** Lance la vibration ; la promesse se résout à la fin de l'effet. Lève une erreur en français. */
export async function playRumble(pad: Gamepad, args: RumbleArgs): Promise<void> {
  const p = pad as PadLike;
  const act = p.vibrationActuator;
  try {
    if (act && typeof act.playEffect === "function") {
      await act.playEffect("dual-rumble", { startDelay: 0, duration: args.duration, strongMagnitude: args.strong, weakMagnitude: args.weak });
      return;
    }
    const haptic = p.hapticActuators?.[0];
    if (haptic && typeof haptic.pulse === "function") {
      await haptic.pulse(Math.max(args.strong, args.weak), args.duration);
      return;
    }
  } catch (e) {
    throw new Error(`Vibration refusée par le navigateur${e instanceof Error && e.message ? ` : ${e.message}` : ""}.`);
  }
  throw new Error("Cette manette (ou ce navigateur) ne sait pas vibrer.");
}

/** Arrête la vibration en cours (sans erreur si rien ne vibre ou si l'arrêt n'existe pas). */
export async function stopRumble(pad: Gamepad): Promise<void> {
  const p = pad as PadLike;
  const act = p.vibrationActuator;
  try {
    if (act && typeof act.reset === "function") await act.reset();
    else if (typeof p.hapticActuators?.[0]?.pulse === "function") await p.hapticActuators[0].pulse!(0, 1);
  } catch {
    /* rien à arrêter */
  }
}

/** Message d'erreur quand aucune manette ne porte l'index demandé. */
export function noPadError(index: number | undefined): string {
  return index === undefined
    ? "Aucune manette visible : appuyer sur un de ses boutons pour la montrer au navigateur."
    : `Aucune manette n° ${index} : appuyer sur un de ses boutons pour la montrer au navigateur.`;
}

/**
 * Suit les vibrations en cours d'un composant (plusieurs manettes possibles) : `active` tant qu'un effet joue.
 * Un effet remplacé ou arrêté ne remet pas `active` à faux à la place du suivant.
 */
export class RumbleTracker {
  private seq = 0;
  private running = 0;

  constructor(private onChange: () => void) {}

  get active(): boolean {
    return this.running > 0;
  }

  /** Lance l'effet sur chaque manette ; rejette avec la première erreur (les autres manettes vibrent quand même). */
  async play(pads: Gamepad[], args: RumbleArgs): Promise<void> {
    const seq = ++this.seq;
    const results = pads.map((pad) => playRumble(pad, args));
    this.running = pads.length;
    this.onChange();
    const settled = await Promise.allSettled(results);
    if (seq === this.seq) {
      this.running = 0;
      this.onChange();
    }
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  async stop(pads: Gamepad[]): Promise<void> {
    this.seq++;
    await Promise.all(pads.map((p) => stopRumble(p)));
    this.running = 0;
    this.onChange();
  }

  reset(): void {
    this.seq++;
    this.running = 0;
  }
}
