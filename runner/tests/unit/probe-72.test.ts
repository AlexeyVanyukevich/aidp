import { describe, expect, it } from "vitest";
import { answer } from "../../src/probe-72.js";

describe("probe-72", () => {
  it("answers 42", () => {
    expect(answer()).toBe(42);
  });
});
