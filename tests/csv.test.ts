import { describe, expect, it } from "vitest";
import { csvCell } from "../src/csv.js";

describe("CSV export", () => {
  it.each(["=1+1", "+cmd", "-2+3", "@SUM(A1:A2)", "  =1+1"])(
    "encodes formula-like cell %s as literal text",
    (value) => {
      expect(csvCell(value)).toBe(`"'${value}"`);
    },
  );

  it("still quotes ordinary cells and embedded quotes", () => {
    expect(csvCell('Travel "offer"')).toBe('"Travel ""offer"""');
  });
});
