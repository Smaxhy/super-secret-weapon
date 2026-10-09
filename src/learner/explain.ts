/**
 * Plain-English recaps of why the bot bought or sold.
 *
 * Built from the same numbers the bot used to decide, so the explanation is
 * always the real reason — not a guess. Stored on each trade and shown on the
 * dashboard and in notifications.
 */
import type { MarketRaw } from '../evaluator/market-analyzer';

const LABEL: Record<string, string> = {
  safety: 'safe contract',
  holders: 'holder count',
  buyPressure: 'buyers outnumbering sellers',
  volume: 'trading volume',
  volumeSpike: 'a fresh volume spike',
  curveVelocity: 'momentum',
  distribution: 'spread-out holders',
  devHolding: 'small dev bag',
  devBehavior: 'dev not selling',
  snipers: 'few bundlers/snipers',
  retention: 'holders sticking around',
  creatorLaunches: 'dev not a serial launcher',
  creatorSuccess: "dev's past launches",
  funderReuse: 'clean funding source',
  walletAge: 'established dev wallet',
  socials: 'real socials',
  narrative: 'matching keywords',
};

const STRATEGY: Record<string, string> = {
  CURVE_SNIPE: 'early bonding-curve entry',
  MIGRATION_MOMENTUM: 'post-migration momentum play',
  SMART_MONEY_COPY: 'copy trade',
};

const pct = (v: number, dp = 0) => `${v.toFixed(dp)}%`;

export function explainBuy(i: {
  symbol: string;
  strategy: string;
  score: number;
  threshold: number;
  contributions: Record<string, number>;
  features: Record<string, number>;
  market: MarketRaw;
  sizeSol: number;
  regime: string;
  risky?: string | null;
  copiedWallet?: string | null;
}): string {
  const m = i.market;
  const strong = Object.entries(i.features)
    .filter(([k, v]) => v >= 0.75 && LABEL[k])
    .sort((a, b) => (i.contributions[b[0]] ?? 0) - (i.contributions[a[0]] ?? 0))
    .slice(0, 4)
    .map(([k]) => LABEL[k]);
  const weak = Object.entries(i.features)
    .filter(([k, v]) => v <= 0.3 && LABEL[k])
    .slice(0, 3)
    .map(([k]) => LABEL[k]);

  const parts = [
    `Bought ${i.sizeSol.toFixed(3)} SOL of ${i.symbol} as a ${STRATEGY[i.strategy] ?? i.strategy}${i.copiedWallet ? ` (a tracked wallet ${i.copiedWallet.slice(0, 4)}… bought first)` : ''}.`,
    `Score ${i.score.toFixed(0)} vs ${i.threshold.toFixed(0)} needed.`,
    strong.length ? `Strongest signals: ${strong.join(', ')}.` : '',
    `At entry: ${m.holders} holders, ${m.volumeUsd ? `$${Math.round(m.volumeUsd).toLocaleString()}` : `${m.volumeSol.toFixed(1)} SOL`} volume, MC ${m.marketCapUsd ? `$${Math.round(m.marketCapUsd).toLocaleString()}` : `${m.marketCapSol.toFixed(0)} SOL`}, ` +
      `buys/sells ${m.buySellRatio.toFixed(1)}, ${m.complete ? 'trading on PumpSwap' : `curve ${pct(m.bondingCurvePct)}`}, ` +
      `dev ${pct(m.devHoldingPct, 1)}, bundlers ${pct(m.earlyBuyerPct, 1)}, top 10 ${pct(m.top10HolderPct)}, fees paid ${m.totalFeesSol.toFixed(2)} SOL.`,
    weak.length ? `Weak spots: ${weak.join(', ')}.` : '',
    i.risky ? `Higher-risk entry (${i.risky}) — bought at reduced size.` : '',
    i.regime !== 'NORMAL' ? `Market mood: ${i.regime.toLowerCase().replace('_', '-')}.` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

export function explainSell(i: {
  symbol: string;
  reason: string;
  detail: string;
  multiple: number;
  peakMultiple: number;
  pct: number;
  closing: boolean;
  heldMinutes: number;
  pnlSol: number;
}): string {
  const why: Record<string, string> = {
    TAKE_PROFIT: 'Took profit',
    TRAILING_STOP: 'Trailing stop hit',
    STOP_LOSS: 'Stop loss',
    RUG_DETECTED: 'Rug warning — got out',
    STALE: 'No movement — freed the capital',
    MIGRATED: 'Migrated with no market to sell into',
    COPY_EXIT: 'The wallet we copied sold',
    MANUAL: 'Sold manually',
    KILL_SWITCH: 'Kill switch',
  };
  return [
    `${why[i.reason] ?? i.reason}: ${i.detail}.`,
    `Sold ${i.closing ? 'the rest' : `${i.pct.toFixed(0)}%`} of ${i.symbol} at ${i.multiple.toFixed(2)}× after ${i.heldMinutes.toFixed(0)} min (peak ${i.peakMultiple.toFixed(2)}×).`,
    `This sell: ${i.pnlSol >= 0 ? '+' : '−'}${Math.abs(i.pnlSol).toFixed(4)} SOL after fees.`,
  ].join(' ');
}
