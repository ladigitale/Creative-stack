/** Types du descripteur de timeline (voir animation.md et schemas/timeline.schema.json). */

export type EaseName = "linear" | "easeIn" | "easeOut" | "easeInOut";
export type Ease = EaseName | [number, number, number, number];

/** Valeurs `[from, to]` par propriété. Propriétés : opacity, x, y, scale, rotate, blur, ou variable `--nom`. */
export type TweenProps = Record<string, [number, number]>;

export type TweenNode = {
  type: "tween";
  targets: string[];
  props: TweenProps;
  duration?: number;
  delay?: number;
  ease?: Ease;
};

/** Texte animé : compteur (`count`) ou machine à écrire (`type`). Écrit uniquement `textContent`. */
export type TextNode = {
  type: "text";
  mode: "count" | "type";
  targets: string[];
  /** `count` : valeurs de départ et d'arrivée. */
  from?: number;
  to?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  delay?: number;
  ease?: Ease;
};

export type SeqNode = { type: "seq"; nodes: TimelineNode[] };
export type ParNode = { type: "par"; nodes: TimelineNode[] };
export type StaggerNode = { type: "stagger"; each?: number; nodes: TimelineNode[] };
export type SetNode = { type: "set"; at?: number; path: string; value: unknown };
export type LabelNode = { type: "label"; name: string; at?: number };

export type TimelineNode =
  | TweenNode
  | TextNode
  | SeqNode
  | ParNode
  | StaggerNode
  | SetNode
  | LabelNode;

export type TimelineDescriptor = {
  /** Chemin DataProvider du temps normalisé 0..1 (ex. `clock-main.t`). */
  timeSource?: string;
  /** Durée totale en secondes ; sinon déduite des nœuds. */
  duration?: number;
  outOfRange?: "clamp" | "wrap";
  /** Constante de temps de lissage en secondes (0 = aucun). */
  smooth?: number;
  root: TimelineNode;
};

/** Problème détecté par le validateur, rédigé pour un agent : `fix` propose une correction. */
export type AnimationIssue = {
  path: string;
  field: string;
  message: string;
  fix: string;
};

export type ClockMode = "once" | "loop" | "pingpong";

export type ClockSnapshot = {
  t: number;
  time: number;
  duration: number;
  playing: boolean;
  rate: number;
  direction: 1 | -1;
  origin: string;
};
