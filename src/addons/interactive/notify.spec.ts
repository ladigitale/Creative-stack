import { describe, expect, it, vi } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicToast } from "@supersoniks/concorde/toast";
import { escapeText, toMessages } from "./notify";
import "./notify";

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("sonic-notify", () => {
  it("lit texte, objet et tableau ; vide = rien", () => {
    expect(toMessages("")).toEqual([]);
    expect(toMessages(null)).toEqual([]);
    expect(toMessages({ status: "error" })).toEqual([]);
    expect(toMessages("Oups", { status: "error" })).toEqual([{ text: "Oups", status: "error" }]);
    expect(toMessages({ text: "Posée", status: "success" })[0]).toMatchObject({ text: "Posée", status: "success" });
    expect(toMessages([{ message: "a" }, "b"]).map((m) => m.text)).toEqual(["a", "b"]);
    expect(toMessages({ text: "x", status: "rouge" }, { status: "info" })[0].status).toBe("info");
  });

  it("échappe le HTML", () => {
    expect(escapeText('<img src=x onerror="a">')).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;");
  });

  it("montre un toast aux changements, pas la valeur de départ ni une répétition", async () => {
    const add = vi.spyOn(SonicToast, "add").mockImplementation(() => undefined as never);
    set("notifySpec", { erreur: "déjà là" });
    const el = document.createElement("sonic-notify");
    el.setAttribute("watch", "notifySpec.erreur");
    el.setAttribute("status", "error");
    document.body.appendChild(el);
    await wait(5);
    expect(add).not.toHaveBeenCalled();
    set("notifySpec", { erreur: "Partage impossible : <b>quota</b>" });
    await wait(5);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toMatchObject({ text: "Partage impossible : &lt;b&gt;quota&lt;/b&gt;", status: "error" });
    set("notifySpec", { erreur: "Partage impossible : <b>quota</b>", autre: 1 });
    await wait(5);
    expect(add).toHaveBeenCalledTimes(1);
    set("notifySpec", { erreur: "" });
    set("notifySpec", { erreur: "Partage impossible : <b>quota</b>" });
    await wait(5);
    expect(add).toHaveBeenCalledTimes(2);
    el.remove();
    add.mockRestore();
  });
});
