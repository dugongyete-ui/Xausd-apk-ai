export type MarketRegime = "trending" | "ranging" | "unknown";

export interface CandleForADX {
  high: number;
  low: number;
  close: number;
}

export function calculateADX(candles: CandleForADX[], period: number = 14): number {
  if (candles.length < period * 2 + 1) return 0;

  const trArr: number[] = [];
  const plusDMArr: number[] = [];
  const minusDMArr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const hl = curr.high - curr.low;
    const hc = Math.abs(curr.high - prev.close);
    const lc = Math.abs(curr.low - prev.close);
    trArr.push(Math.max(hl, hc, lc));

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    plusDMArr.push(plusDM);
    minusDMArr.push(minusDM);
  }

  let smoothTR = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDMArr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMArr.slice(0, period).reduce((a, b) => a + b, 0);

  const dxArr: number[] = [];

  const firstPlusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
  const firstMinusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
  const firstDISum = firstPlusDI + firstMinusDI;
  const firstDX = firstDISum > 0 ? (Math.abs(firstPlusDI - firstMinusDI) / firstDISum) * 100 : 0;
  dxArr.push(firstDX);

  for (let i = period; i < trArr.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trArr[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMArr[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMArr[i];

    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxArr.push(dx);
  }

  if (dxArr.length < period) return 0;

  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }

  return adx;
}

export function detectMarketRegime(m15Candles: CandleForADX[], period: number = 14): MarketRegime {
  const adx = calculateADX(m15Candles, period);
  if (adx === 0) return "unknown";
  if (adx > 25) return "trending";
  if (adx < 20) return "ranging";
  return "unknown";
}
