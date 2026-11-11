import { afterEach, describe, expect, it, vi } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./index";
import type { SonicMediaDownload } from "./download";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("sonic-media-download auto", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("télécharge chaque nouveau média publié, pas celui présent au branchement", async () => {
    PublisherManager.get("dlAuto").set({ last: { url: "blob:ancien", mime: "image/png" } });
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(`${this.getAttribute("href")}|${this.download}`);
    });
    const el = document.createElement("sonic-media-download") as SonicMediaDownload;
    el.setAttribute("source", "dlAuto.last");
    el.setAttribute("filename", "abysse fini");
    el.setAttribute("auto", "");
    document.body.appendChild(el);
    await el.updateComplete;
    await flush();
    expect(clicks).toEqual([]);
    expect(el.shadowRoot?.querySelector("a[part=link]")).toBeNull();

    PublisherManager.get("dlAuto").set({ last: { url: "blob:nouveau", mime: "image/png" } });
    await flush();
    expect(clicks).toEqual(["blob:nouveau|abysse-fini.png"]);

    PublisherManager.get("dlAuto").set({ last: { url: "blob:nouveau", mime: "image/png" } });
    await flush();
    expect(clicks.length).toBe(1);
  });

  it("sans auto : lien affiché, aucun téléchargement spontané", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const el = document.createElement("sonic-media-download") as SonicMediaDownload;
    el.setAttribute("source", "dlManuel.last");
    document.body.appendChild(el);
    await el.updateComplete;
    PublisherManager.get("dlManuel").set({ last: { url: "blob:x", mime: "image/svg+xml" } });
    await flush();
    await el.updateComplete;
    expect(click).not.toHaveBeenCalled();
    expect(el.shadowRoot?.querySelector("a[part=link]")?.getAttribute("download")).toBe("creation.svg");
  });

  it("wait : seul le média demandé par un clic sur le contenu est téléchargé", async () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(String(this.getAttribute("href")));
    });
    PublisherManager.get("dlWait").set({ last: { url: "blob:a", mime: "image/png" } });
    const el = document.createElement("sonic-media-download") as SonicMediaDownload;
    el.setAttribute("source", "dlWait.last");
    el.setAttribute("wait", "");
    const btn = document.createElement("button");
    el.appendChild(btn);
    document.body.appendChild(el);
    await el.updateComplete;
    await flush();
    PublisherManager.get("dlWait").set({ last: { url: "blob:b", mime: "image/png" } });
    await flush();
    expect(clicks).toEqual([]);
    btn.click();
    PublisherManager.get("dlWait").set({ last: { url: "blob:c", mime: "image/png" } });
    await flush();
    expect(clicks).toEqual(["blob:c"]);
    PublisherManager.get("dlWait").set({ last: { url: "blob:d", mime: "image/png" } });
    await flush();
    expect(clicks).toEqual(["blob:c"]);
  });
});
