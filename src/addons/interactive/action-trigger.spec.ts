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
});
