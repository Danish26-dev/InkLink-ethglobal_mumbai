/**
 * Money utilities — decimal strings only, no floating point (locked rule).
 *
 * HTS token amounts settle in the token's smallest unit (per `decimals`).
 * We parse decimal strings into BigInt smallest units and compare with BigInt.
 */

/** Parse a decimal string like "20.00" into smallest units given decimals. */
export function toSmallestUnit(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Invalid decimal amount: "${amount}"`);
  }
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${amount}" has more fractional digits than token decimals (${decimals})`,
    );
  }
  const paddedFrac = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
}

/** Format smallest units back to a decimal string with `decimals` places. */
export function fromSmallestUnit(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0");
  const s = decimals > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${s}` : s;
}

/** Compare two decimal strings. Returns -1 | 0 | 1. */
export function compareDecimal(a: string, b: string, decimals: number): number {
  const ua = toSmallestUnit(a, decimals);
  const ub = toSmallestUnit(b, decimals);
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/** Sum two decimal strings, returning a decimal string. */
export function addDecimal(a: string, b: string, decimals: number): string {
  return fromSmallestUnit(
    toSmallestUnit(a, decimals) + toSmallestUnit(b, decimals),
    decimals,
  );
}

/** a - b, floored at zero (used to release a spend reservation). */
export function subDecimal(a: string, b: string, decimals: number): string {
  const diff = toSmallestUnit(a, decimals) - toSmallestUnit(b, decimals);
  return fromSmallestUnit(diff < 0n ? 0n : diff, decimals);
}
