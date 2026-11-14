import { describe, expect, it } from "vitest";
import { safeTokenEquals, bearerToken } from "../src/lib/secrets";

describe("secret verification", () => {
  it("accepts only exact matching nonempty tokens", () => {
    expect(safeTokenEquals("abc", "abc")).toBe(true);
    expect(safeTokenEquals("abc", "def")).toBe(false);
    expect(safeTokenEquals("abc", "abcd")).toBe(false);
    expect(safeTokenEquals("", "")).toBe(false);
    expect(safeTokenEquals(undefined, "abc")).toBe(false);
  });
  it("requires an explicit Bearer token", () => {
    expect(bearerToken(new Request("http://localhost", { headers: { authorization: "Bearer hello" } }))).toBe("hello");
    expect(bearerToken(new Request("http://localhost", { headers: { authorization: "Basic hello" } }))).toBeUndefined();
  });
});
