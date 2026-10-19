/**
 * Recettes de `sonic-animate` : des descripteurs de timeline (données JSON, pas de code),
 * paramétrés par les attributs de l'élément. Cible : les enfants directs de `sonic-animate`.
 */
import type { Ease, TimelineDescriptor, TimelineNode } from "./types";

export const RECIPE_NAMES = ["reveal", "fade", "slide-up", "count-up", "typewriter"] as const;
export type RecipeName = (typeof RECIPE_NAMES)[number];

export type RecipeOptions = {
  /** Durée d'un effet en secondes (défaut propre à la recette). */
  duration?: number;
  /** Décalage entre enfants en secondes. */
  stagger?: number;
  ease?: Ease;
  from?: number;
  to?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
};

const CHILDREN = "children:@self";

type Recipe = { duration: number; stagger: number; build: (o: Required<Pick<RecipeOptions, "duration" | "stagger">> & RecipeOptions) => TimelineNode };

const tweenAll = (props: Record<string, [number, number]>, o: { duration: number; stagger: number; ease?: Ease }): TimelineNode => ({
  type: "stagger",
  each: o.stagger,
  nodes: [{ type: "tween", targets: [CHILDREN], props, duration: o.duration, ease: o.ease ?? "easeOut" }],
});

export const RECIPES: Record<RecipeName, Recipe> = {
  reveal: { duration: 0.6, stagger: 0.08, build: (o) => tweenAll({ opacity: [0, 1], y: [16, 0] }, o) },
  fade: { duration: 0.5, stagger: 0, build: (o) => tweenAll({ opacity: [0, 1] }, o) },
  "slide-up": { duration: 0.6, stagger: 0.08, build: (o) => tweenAll({ opacity: [0, 1], y: [40, 0] }, o) },
  "count-up": {
    duration: 1.2,
    stagger: 0,
    build: (o) => ({
      type: "text",
      mode: "count",
      targets: [CHILDREN],
      from: o.from ?? 0,
      to: o.to ?? 100,
      decimals: o.decimals ?? 0,
      prefix: o.prefix ?? "",
      suffix: o.suffix ?? "",
      duration: o.duration,
      ease: o.ease ?? "easeOut",
    }),
  },
  typewriter: {
    duration: 1.5,
    stagger: 0,
    build: (o) => ({ type: "text", mode: "type", targets: [CHILDREN], duration: o.duration, ease: o.ease ?? "linear" }),
  },
};

export function isRecipe(name: unknown): name is RecipeName {
  return typeof name === "string" && (RECIPE_NAMES as readonly string[]).includes(name);
}

/** Descripteur de timeline d'une recette (sans `timeSource` : `sonic-animate` fournit sa propre horloge). */
export function buildRecipe(name: RecipeName, options: RecipeOptions = {}): TimelineDescriptor {
  const r = RECIPES[name];
  const duration = options.duration && options.duration > 0 ? options.duration : r.duration;
  const stagger = options.stagger !== undefined && options.stagger >= 0 ? options.stagger : r.stagger;
  return { outOfRange: "clamp", root: r.build({ ...options, duration, stagger }) };
}
