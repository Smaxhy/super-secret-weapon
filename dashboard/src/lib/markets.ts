/** v27: price decimals, pip size and chart symbol per market (currency pairs, metals, coins, US stock indices). */
const INDEX: Record<string, { pip: number; tv: string }> = {
  NDXUSD: { pip: 1, tv: 'OANDA:NAS100USD' },
  SPXUSD: { pip: 0.1, tv: 'OANDA:SPX500USD' },
  DJIUSD: { pip: 1, tv: 'OANDA:US30USD' },
  RUTUSD: { pip: 0.1, tv: 'OANDA:US2000USD' },
};
const COIN_PIP: Record<string, number> = { BTCUSD: 1, ETHUSD: 0.1, SOLUSD: 0.01, XRPUSD: 0.0001, DOGEUSD: 0.00001, ADAUSD: 0.0001, LINKUSD: 0.001, AVAXUSD: 0.001 };

export const isIndexId = (id: string) => id in INDEX;
export const isCoinId = (id: string) => id in COIN_PIP;
/** priced straight in dollars (metals, coins, indices): no currency on the base side */
export const usdPriced = (id: string) => id.startsWith('XA') || isIndexId(id) || isCoinId(id);

export function pipOf(id: string): number {
  if (INDEX[id]) return INDEX[id].pip;
  if (COIN_PIP[id]) return COIN_PIP[id];
  if (id === 'XAUUSD') return 0.01;
  if (id === 'XAGUSD') return 0.001;
  return id.includes('JPY') ? 0.01 : 0.0001;
}

export function digitsOf(id: string): number {
  if (INDEX[id]) return 2;
  const d = Math.max(0, Math.round(-Math.log10(pipOf(id))));
  return usdPriced(id) ? d : d + 1;
}

export const tvSymbol = (id: string) => INDEX[id]?.tv ?? (isCoinId(id) ? `COINBASE:${id}` : `OANDA:${id}`);
