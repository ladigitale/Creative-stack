import { describe, expect, it } from "vitest";
import "./action";
import { registerStore, unregisterStore, type SonicActionMessage } from "./registry";

describe("sonic-action : déclencheur par évènement d'un enfant direct", () => {
  it("trigger=\"hide\" : l'évènement non remontant de l'enfant direct déclenche, pas celui d'un descendant", async () => {
    const got: SonicActionMessage[] = [];
    registerStore({ id: "uiTest", dispatch: (a: SonicActionMessage) => got.push(a) } as never);
    const act = document.createElement("sonic-action");
    act.setAttribute("trigger", "hide");
    act.setAttribute("target", "uiTest");
    act.setAttribute("type", "close");
    const child = document.createElement("div");
    const deep = document.createElement("span");
    child.appendChild(deep);
    act.appendChild(child);
    document.body.appendChild(act);
    await (act as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    deep.dispatchEvent(new CustomEvent("hide"));
    expect(got).toHaveLength(0);
    child.dispatchEvent(new CustomEvent("hide"));
    expect(got.map((a) => a.type)).toEqual(["close"]);
    child.click();
    expect(got).toHaveLength(1);
    act.remove();
    child.dispatchEvent(new CustomEvent("hide"));
    expect(got).toHaveLength(1);
    unregisterStore("uiTest");
  });

  const mount = async (attrs: Record<string, string>, id: string) => {
    const got: SonicActionMessage[] = [];
    registerStore({ id, dispatch: (a: SonicActionMessage) => got.push(a) } as never);
    const act = document.createElement("sonic-action");
    for (const [k, v] of Object.entries({ target: id, type: "go", ...attrs })) act.setAttribute(k, v);
    const child = document.createElement("button");
    act.appendChild(child);
    document.body.appendChild(act);
    await (act as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const down = () => child.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    const up = () => child.dispatchEvent(new Event("pointerup", { bubbles: true, composed: true }));
    return { got, child, down, up, done: () => { act.remove(); unregisterStore(id); } };
  };

  it("par défaut : au clic, pas à l'appui", async () => {
    const t = await mount({}, "actDefaut");
    t.down();
    t.up();
    expect(t.got).toHaveLength(0);
    t.child.click();
    expect(t.got.map((a) => a.type)).toEqual(["go"]);
    t.done();
  });

  it("trigger=\"pointerdown\" : dès l'appui, pas au clic", async () => {
    const t = await mount({ trigger: "pointerdown" }, "actAppui");
    t.down();
    t.up();
    expect(t.got).toHaveLength(1);
    t.child.click();
    expect(t.got).toHaveLength(1);
    t.done();
  });

  it("hold-repeat sans trigger : dès l'appui", async () => {
    const t = await mount({ "hold-repeat": "5000,5000" }, "actHold");
    t.down();
    t.up();
    expect(t.got).toHaveLength(1);
    t.child.click();
    expect(t.got).toHaveLength(1);
    t.done();
  });
});
