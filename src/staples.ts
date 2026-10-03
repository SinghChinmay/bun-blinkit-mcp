import { searchProducts } from "./api";
import type { Product } from "./parse";
import type { Staple } from "./store";

/**
 * Pure multi-factor scorer for choosing which product to buy. Kept free of I/O
 * so it can be unit-tested. "Balance brand & price": brand/attribute matches
 * matter most, then availability, then price.
 */
export interface ScorerWeights {
  brand: number;
  attr: number;
  eta: number;
  price: number;
}

export const DEFAULT_WEIGHTS: ScorerWeights = {
  brand: 5,
  attr: 4,
  eta: 3,
  price: 2,
};

/** Auto-swap to a cheaper equivalent only if it saves at least this fraction. */
export const DEFAULT_SWAP_THRESHOLD = 0.15;

export const DEFAULT_STAPLES: Staple[] = [
  { key: "milk", query: "milk", attrs: ["full cream"], unit: "500 ml", quantity: 1, auto: true },
  { key: "bread", query: "brown bread", quantity: 1, auto: true },
  { key: "eggs", query: "eggs", quantity: 1, auto: true },
];

const has = (hay: string | undefined, needle: string) =>
  (hay ?? "").toLowerCase().includes(needle.toLowerCase());

export interface PickResult {
  chosen?: Product;
  alternatives: Product[];
  reason: string;
}

export function pickBest(
  candidates: Product[],
  opts: { brands?: string[]; attrs?: string[]; maxPrice?: number; unit?: string },
  weights: ScorerWeights = DEFAULT_WEIGHTS,
  swapThreshold = DEFAULT_SWAP_THRESHOLD,
): PickResult {
  let pool = candidates.filter((p) => (p.inventory ?? 1) > 0);
  if (opts.attrs?.length) {
    const strict = pool.filter((p) =>
      opts.attrs!.every((a) => has(p.name, a) || has(p.unit, a) || has(p.brand, a)),
    );
    if (strict.length) pool = strict;
  }
  if (opts.unit) {
    const byUnit = pool.filter((p) => has(p.unit, opts.unit!));
    if (byUnit.length) pool = byUnit;
  }
  if (opts.maxPrice !== undefined) {
    pool = pool.filter((p) => (p.price ?? Infinity) <= opts.maxPrice!);
  }
  if (!pool.length) pool = candidates;

  const prices = pool.map((p) => p.price ?? Infinity).filter((n) => Number.isFinite(n));
  const minP = Math.min(...prices, Infinity);
  const maxP = Math.max(...prices, 0);
  const priceRange = maxP - minP || 1;

  const score = (p: Product): number => {
    const brand = opts.brands?.some((b) => has(p.brand, b) || has(p.name, b)) ? 1 : 0;
    const attr = opts.attrs?.length
      ? opts.attrs.filter((a) => has(p.name, a) || has(p.unit, a)).length / opts.attrs.length
      : 0;
    const eta = (p.inventory ?? 0) > 0 ? 1 : 0;
    const price = p.price !== undefined ? 1 - (p.price - minP) / priceRange : 0;
    return weights.brand * brand + weights.attr * attr + weights.eta * eta + weights.price * price;
  };

  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  let chosen = ranked[0];
  let reason = "top multi-factor score";

  if (chosen && opts.brands?.length) {
    const brandPick = ranked.find((p) =>
      opts.brands!.some((b) => has(p.brand, b) || has(p.name, b)),
    );
    if (brandPick && brandPick.price !== undefined) {
      const cheaper = ranked.find(
        (p) =>
          p.price !== undefined &&
          p.price < brandPick.price! * (1 - swapThreshold) &&
          (!opts.attrs?.length || opts.attrs.every((a) => has(p.name, a) || has(p.unit, a))),
      );
      if (cheaper && cheaper !== brandPick) {
        chosen = cheaper;
        reason = `swapped to cheaper equivalent (saves ≥${Math.round(swapThreshold * 100)}% vs preferred brand)`;
      } else {
        chosen = brandPick;
        reason = "preferred brand kept (no meaningful cheaper equivalent)";
      }
    }
  }

  return { chosen, alternatives: ranked.filter((p) => p !== chosen).slice(0, 5), reason };
}

/** Resolve one staple to a live product using search + the scorer. */
export async function resolveStaple(
  s: Staple,
  weights: ScorerWeights = DEFAULT_WEIGHTS,
  swapThreshold = DEFAULT_SWAP_THRESHOLD,
): Promise<Product | undefined> {
  const results = await searchProducts(s.query);
  if (s.product_id) {
    const exact = results.find((p) => p.product_id === s.product_id);
    if (exact) return exact;
  }
  const { chosen } = pickBest(
    results,
    { brands: s.brands, attrs: s.attrs, unit: s.unit },
    weights,
    swapThreshold,
  );
  return chosen;
}
