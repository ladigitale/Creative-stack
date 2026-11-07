import { describe, expect, it } from "vitest";
import { errorMessage } from "./store";

describe("errorMessage", () => {
  it("rend lisible une erreur JSONata (objet)", () => {
    expect(errorMessage({ code: "T2002", message: 'The right side of the "*" operator must evaluate to a number', position: 42 })).toBe(
      'T2002 : The right side of the "*" operator must evaluate to a number (position 42)',
    );
  });
  it("garde Error et chaînes", () => {
    expect(errorMessage(new Error("boum"))).toBe("boum");
    expect(errorMessage("texte")).toBe("texte");
    expect(errorMessage({ a: 1 })).toBe('{"a":1}');
  });
});
