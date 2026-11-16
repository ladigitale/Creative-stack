/**
 * Machines connues : valeurs par défaut tant que les réglages (`$$`) ne sont pas lus, et zone de travail de
 * référence quand le micrologiciel en annonce une fausse (`$130` / `$131` laissés à la valeur d'usine).
 */
export type MachineProfile = {
  label: string;
  /** Zone de travail en mm (X, Y) ; `null` : lue sur la machine. */
  area: [number, number] | null;
  /** Valeur S de pleine puissance (`$30`). */
  maxS: number;
  /** Fins de course et prise d'origine. */
  homing: boolean;
  /** Validée sur matériel par ce dépôt. */
  tested: boolean;
};

export const MACHINES: Record<string, MachineProfile> = {
  auto: { label: "GRBL", area: null, maxS: 1000, homing: false, tested: false },
  /** Atomstack A5 Pro / A5 Pro+ : diode, pont CH340, 115200 bauds, sans fin de course (origine posée à la main). */
  "atomstack-a5-pro": { label: "Atomstack A5 Pro", area: [410, 400], maxS: 1000, homing: false, tested: false },
};

export function getMachine(name: string): MachineProfile | null {
  return Object.prototype.hasOwnProperty.call(MACHINES, name) ? MACHINES[name] : null;
}

/** Source de programme G-code (`sonic-gcode`) lue par `sonic-grbl source="#id"`. */
export type SonicGcodeSource = {
  /** Lignes du programme, ou `null` tant qu'il n'est pas prêt. */
  getGcode(): string[] | null;
  /** Incrémenté à chaque nouveau programme. */
  readonly gcodeSeq: number;
};

export function isGcodeSource(el: unknown): el is SonicGcodeSource {
  if (!el || typeof el !== "object") return false;
  const o = el as SonicGcodeSource;
  return typeof o.getGcode === "function" && typeof o.gcodeSeq === "number";
}
