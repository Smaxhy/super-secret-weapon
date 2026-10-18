/**
 * Launch covariates (v11.11) — arXiv 2607.02823 (832k pump.fun launches): a Telegram link graduated 8.9× more often and a
 * launch market cap above the 30 SOL default (creator self-buy) carried 4.5× the hazard. Stored on every evaluation as
 * `features.launch` so the win model / rule search / AI coach can weigh them — NO rule and NO points here.
 */

export interface LaunchFeatures {
  telegram: 0 | 1;
  /** the creator's launch buy (SOL); null = not seen */
  initialBuySol: number | null;
  /** curve market cap right after creation incl. that buy (SOL) */
  initialMcSol: number | null;
  /** the creator's launch buy as % of the supply */
  devSelfBuyPct: number | null;
}

const TG = /(?:^|[\s/(])(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/[A-Za-z0-9_+]/i;

/** Any Telegram link in the token's socials, website or description. */
export function hasTelegramLink(t: { telegram?: string | null; website?: string | null; description?: string | null }): boolean {
  return [t.telegram, t.website, t.description].some((f) => !!f && TG.test(` ${f}`));
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Pure. Reserves / supply in raw units (lamports, 6-decimal token units) as stored in the live hash. */
export function launchFeatures(i: {
  telegram?: string | null;
  website?: string | null;
  description?: string | null;
  initVSolLamports: bigint;
  initVTokRaw: bigint;
  supplyRaw: bigint;
  /** the creator's launch buy; null + `devBoughtRaw` 0 = they bought nothing at launch */
  devBuyLamports: bigint | null;
  devBuyTokens: bigint | null;
  devBoughtRaw: bigint;
  adopted: boolean;
}): LaunchFeatures {
  const telegram: 0 | 1 = hasTelegramLink(i) ? 1 : 0;
  if (i.adopted || i.initVSolLamports <= 0n || i.initVTokRaw <= 0n || i.supplyRaw <= 0n) return { telegram, initialBuySol: null, initialMcSol: null, devSelfBuyPct: null };
  let lam = i.devBuyLamports;
  let tok = i.devBuyTokens;
  if (lam === null || tok === null) {
    if (i.devBoughtRaw > 0n) return { telegram, initialBuySol: null, initialMcSol: null, devSelfBuyPct: null };
    lam = 0n;
    tok = 0n;
  }
  const vSol = Number(i.initVSolLamports + lam);
  const vTok = Number(i.initVTokRaw - tok);
  const supply = Number(i.supplyRaw);
  return {
    telegram,
    initialBuySol: r2(Number(lam) / 1e9),
    initialMcSol: vTok > 0 ? r2(((vSol / vTok) * supply) / 1e9) : null,
    devSelfBuyPct: r2((Number(tok) / supply) * 100),
  };
}
