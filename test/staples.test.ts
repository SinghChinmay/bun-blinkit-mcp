import { describe, expect, test } from "bun:test";
import { pickBest, DEFAULT_WEIGHTS } from "../src/staples";
import type { Product } from "../src/parse";

const p = (product_id: number, name: string, price: number, brand?: string, unit?: string): Product => ({
  product_id,
  name,
  price,
  brand,
  unit,
  inventory: 5,
});

const candidates: Product[] = [
  p(1, "Amul Full Cream Milk", 34, "Amul", "500 ml"),
  p(2, "Mother Dairy Full Cream Milk", 33, "Mother Dairy", "500 ml"),
  p(3, "Local Full Cream Milk", 20, undefined, "500 ml"),
  p(4, "Amul Toned Milk", 28, "Amul", "500 ml"),
];

describe("pickBest", () => {
  test("prefers the requested brand when no cheaper equivalent clears the threshold", () => {
    const { chosen } = pickBest(
      [candidates[0], candidates[1]],
      { brands: ["Amul"], attrs: ["full cream"] },
      DEFAULT_WEIGHTS,
    );
    expect(chosen?.brand).toBe("Amul");
  });

  test("swaps to a much cheaper equivalent beyond the threshold", () => {
    const { chosen, reason } = pickBest(
      candidates,
      { brands: ["Amul"], attrs: ["full cream"] },
      DEFAULT_WEIGHTS,
      0.15,
    );
    expect(chosen?.product_id).toBe(3);
    expect(reason).toContain("cheaper");
  });

  test("respects maxPrice and attribute filters", () => {
    const { chosen } = pickBest(
      candidates,
      { attrs: ["toned"], maxPrice: 30 },
      DEFAULT_WEIGHTS,
    );
    expect(chosen?.product_id).toBe(4);
  });

  test("falls back to all candidates when filters exclude everything", () => {
    const { chosen } = pickBest(
      candidates,
      { brands: ["Nonexistent"], attrs: ["unicorn"] },
      DEFAULT_WEIGHTS,
    );
    expect(chosen).toBeDefined();
  });

  test("honors a unit preference when a match exists", () => {
    const mixed: Product[] = [
      p(1, "Amul Milk", 20, "Amul", "200 ml"),
      p(2, "Amul Milk", 60, "Amul", "1 L"),
    ];
    const { chosen } = pickBest(mixed, { unit: "1 L" }, DEFAULT_WEIGHTS);
    expect(chosen?.product_id).toBe(2);
  });
});
