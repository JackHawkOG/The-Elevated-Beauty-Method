import { expect, test } from "vitest";
import { withBrandTrademarks } from "./brand-copy";

test("normalizes either brand name without swallowing following spaces", () => {
  expect(withBrandTrademarks(
    "The Elevated Beauty Method is here. The Elevated Beauty Experience™ begins now.",
  )).toBe(
    "The Elevated Beauty Method ™ is here. The Elevated Beauty Experience ™ begins now.",
  );
  expect(withBrandTrademarks("The Elevated Beauty Method ™")).toBe("The Elevated Beauty Method ™");
  expect(withBrandTrademarks("The Elevated Beauty Methodology")).toBe("The Elevated Beauty Methodology");
});