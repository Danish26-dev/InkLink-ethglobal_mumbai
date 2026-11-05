/**
 * MOCK FX conversion. The real backend uses a configurable trusted FX source;
 * this exists only so the dev flow has a USDC amount to pay.
 *
 * Agreed policy, mirrored here so the mock behaves like the real thing:
 *  - USDC to 6 decimal places
 *  - round UP, so the shop is never undercharged
 *  - integer arithmetic only (no floating point money)
 */

function parseDecimal(text: string, maxFrac: number): { units: bigint; scale: bigint } {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`invalid decimal: ${text}`);
  const [whole, frac = ""] = text.split(".");
  if (frac.length > maxFrac) throw new Error(`too many decimals: ${text}`);
  const scale = 10n ** BigInt(maxFrac);
  return { units: BigInt(whole) * scale + BigInt(frac.padEnd(maxFrac, "0")), scale };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * inrAmount: "20.00"  rate: USDC per 1 INR, e.g. "0.005"  ->  "0.10"
 * Output has at least 2 and at most 6 decimals (trailing zeros trimmed, never below 2).
 */
export function inrToUsdc(inrAmount: string, rate: string): string {
  const inr = parseDecimal(inrAmount, 2); // paise
  const r = parseDecimal(rate, 9); // rate * 1e9
  // usdcMicro = inr * rate * 1e6 = (paise/100) * (rateScaled/1e9) * 1e6
  const micro = ceilDiv(inr.units * r.units, 100_000n);
  const whole = micro / 1_000_000n;
  let frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}
