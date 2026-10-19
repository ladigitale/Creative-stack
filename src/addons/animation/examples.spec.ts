import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { BASE_PROPS } from "./timeline-core";
import { RECIPE_NAMES } from "./recipes";
import { validateSduiAnimation, validateTimelineDescriptor } from "./validate";
import manifestJson from "./manifest.json";
import reveal from "./examples/reveal-liste.sdui.json";
import horloge from "./examples/horloge-timeline.sdui.json";
import scrub from "./examples/scrub.sdui.json";

/** Le manifeste est un JSON hétérogène : on le lit par une forme minimale. */
const manifest = manifestJson as unknown as {
  examples: string[];
  components: Array<{ name: string; props: Record<string, { description?: string }> }>;
};

const here = __dirname;
const read = (p: string) => readFileSync(path.join(here, p), "utf8");

describe("exemples SDUI", () => {
  it.each([
    ["reveal-liste", reveal],
    ["horloge-timeline", horloge],
    ["scrub", scrub],
  ])("%s passe le validateur sans problème", (_name, doc) => {
    expect(validateSduiAnimation(doc)).toEqual([]);
  });

  it("le manifeste liste exactement les exemples présents", () => {
    for (const f of manifest.examples) expect(() => read(f)).not.toThrow();
  });

  it("le descripteur partagé de horloge-timeline et scrub est le même", () => {
    const find = (doc: typeof horloge) =>
      (doc.nodes[0].nodes as Array<{ tagName: string; attributes?: { descriptor?: string } }>).find((n) => n.tagName === "sonic-timeline")!.attributes!
        .descriptor!;
    expect(find(horloge)).toBe(find(scrub as unknown as typeof horloge));
    expect(validateTimelineDescriptor(JSON.parse(find(horloge)))).toEqual([]);
  });
});

describe("cohérence code / schéma / manifeste / doc", () => {
  const schema = JSON.parse(readFileSync(path.join(here, "../../../schemas/timeline.schema.json"), "utf8"));
  const doc = read("animation.md");
  const animate = manifest.components.find((c) => c.name === "sonic-animate")!;

  it("les propriétés animables du schéma = celles du code", () => {
    expect(Object.keys(schema.$defs.tweenProps.properties).sort()).toEqual([...BASE_PROPS].sort());
  });

  it("chaque recette est décrite dans le manifeste et la doc", () => {
    for (const r of RECIPE_NAMES) {
      expect(animate.props.recipe.description, r).toContain(r);
      expect(doc, r).toContain(`\`${r}\``);
    }
  });

  it("chaque attribut déclaré dans le manifeste est documenté", () => {
    for (const c of manifest.components) {
      expect(doc).toContain(c.name);
      for (const prop of Object.keys(c.props)) expect(doc, `${c.name} ${prop}`).toContain(`\`${prop}\``);
    }
  });

  it("types de nœuds du schéma = types gérés par le validateur", () => {
    const types = schema.$defs.node.oneOf.flatMap((n: { properties: { type: { const?: string; enum?: string[] } } }) =>
      n.properties.type.const ? [n.properties.type.const] : n.properties.type.enum,
    );
    expect([...types].sort()).toEqual(["label", "par", "seq", "set", "stagger", "text", "tween"]);
  });
});
