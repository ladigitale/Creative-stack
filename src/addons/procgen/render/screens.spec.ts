import { describe, expect, it } from "vitest";
import { readScreen } from "./screens";

describe("écrans animés : lecture du contenu", () => {
  it("chaînes, vidéos, images, éléments de la page", () => {
    expect(readScreen("news")).toEqual({ channel: "news" });
    expect(readScreen("#monCanvas")).toEqual({ element: "#monCanvas" });
    expect(readScreen("https://exemple.org/clip.mp4")).toEqual({ video: "https://exemple.org/clip.mp4" });
    expect(readScreen("/img/affiche.png")).toEqual({ image: "/img/affiche.png" });
    expect(readScreen({ images: ["a.png", "b.png"], interval: 3 })).toEqual({ images: ["a.png", "b.png"], interval: 3 });
    expect(readScreen({ on: false })).toEqual({ on: false });
    expect(readScreen(true)).toEqual({ channel: "bars" });
  });
  it("refuse les schémas dangereux et les sélecteurs libres", () => {
    expect(readScreen("javascript:alert(1)")).toBeNull();
    expect(readScreen({ video: "http://exemple.org/x.mp4" })).toEqual({ channel: "bars" });
    expect(readScreen({ image: "data:text/html,<b>x</b>" })).toEqual({ channel: "bars" });
    expect(readScreen({ element: "div > canvas" })).toEqual({ channel: "bars" });
    expect(readScreen({ channel: "inconnue", text: "x".repeat(500) })!.text!.length).toBe(200);
  });
});
