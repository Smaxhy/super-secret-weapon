/**
 * Safety checker — "can this token hurt us?"
 *
 * Phase 1 checks (all from one getAccountInfo call + our own data):
 *   1. Token program is SPL Token or Token-2022 (anything else = unknown code)
 *   2. Mint authority is revoked (otherwise dev can print infinite tokens)
 *   3. Freeze authority is revoked (otherwise dev can freeze your tokens = honeypot)
 *   4. No dangerous Token-2022 extensions (transfer hooks, permanent delegate,
 *      pausable, non-transferable, default-frozen accounts, transfer fees)
 *   5. Supply / decimals match the standard Pump.fun mint
 *   6. Dev's initial buy isn't a huge chunk of supply
 *   7. Creator isn't on our blacklist
 *   8. Name / symbol / metadata look sane
 *
 * Later phases add: honeypot sell simulation (Phase 4), LP status after
 * migration (Phase 6).
 *
 * Score = 100 minus penalties. Any hard-fail item forces `hardFail = true`,
 * which the scorer treats as an automatic reject no matter the score.
 */
import { ExtensionType, getExtensionTypes, unpackMint } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { SAFETY_PENALTIES as P } from '../config/default';
import type { SafetyCheckItem, SafetyReport } from '../config/types';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { PUMP_DEFAULT_TOTAL_SUPPLY, PUMP_TOKEN_DECIMALS, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../lib/pumpfun';
import { getConnection } from '../lib/solana';
import type { LiveState } from '../scanner/live-state';

const log = moduleLogger('safety-checker');

/** Token-2022 extensions that let the issuer block, seize or tax your tokens. */
const HARD_FAIL_EXTENSIONS = new Set([
  'TransferHook', // arbitrary code runs on every transfer — can block sells
  'PermanentDelegate', // issuer can move/burn tokens out of YOUR wallet
  'NonTransferable', // literally can't sell
  'PausableConfig', // issuer can pause all transfers
  'DefaultAccountState', // new holder accounts can start frozen
  'PermissionedBurn',
]);
/** Extensions that are a cost or a warning sign, but not an instant reject. */
const WARN_EXTENSIONS = new Set(['TransferFeeConfig', 'ConfidentialTransferMint', 'MintCloseAuthority', 'InterestBearingConfig', 'ScaledUiAmountConfig']);

/** Everything evaluateSafety needs. Kept separate so it can be unit-tested without RPC. */
export interface SafetyInputs {
  mint: string;
  owner: string; // program that owns the mint account
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: bigint;
  extensions: string[];
  name: string;
  symbol: string;
  uri: string;
  devInitialBuyPct: number | null;
  creatorBlacklisted: boolean;
}

/** Pure scoring function: facts in → report out. */
export function evaluateSafety(i: SafetyInputs): SafetyReport {
  const checks: SafetyCheckItem[] = [];
  const add = (id: string, label: string, failed: boolean, penalty: number, detail: string, hard = false) => {
    checks.push({
      id,
      label,
      severity: failed ? (hard ? 'FAIL' : 'WARN') : 'PASS',
      penalty: failed ? penalty : 0,
      detail,
    });
  };

  const knownProgram = i.owner === TOKEN_PROGRAM_ID || i.owner === TOKEN_2022_PROGRAM_ID;
  add('token_program', 'Standard token program', !knownProgram, P.unknownTokenProgram, knownProgram ? (i.owner === TOKEN_2022_PROGRAM_ID ? 'Token-2022' : 'SPL Token') : `Unknown owner ${i.owner}`, true);

  add('mint_authority', 'Mint authority revoked', i.mintAuthority !== null, P.mintAuthority, i.mintAuthority ? `Mint authority still set: ${i.mintAuthority}` : 'Revoked', true);

  add('freeze_authority', 'Freeze authority revoked', i.freezeAuthority !== null, P.freezeAuthority, i.freezeAuthority ? `Freeze authority still set: ${i.freezeAuthority}` : 'Revoked', true);

  const hardExt = i.extensions.filter((e) => HARD_FAIL_EXTENSIONS.has(e));
  add('dangerous_extensions', 'No dangerous Token-2022 extensions', hardExt.length > 0, P.dangerousExtension, hardExt.length ? `Found: ${hardExt.join(', ')}` : 'None', true);

  const warnExt = i.extensions.filter((e) => WARN_EXTENSIONS.has(e));
  add('risky_extensions', 'No fee / unusual extensions', warnExt.length > 0, P.transferFee, warnExt.length ? `Found: ${warnExt.join(', ')}` : 'None');

  const supplyOk = i.supply === PUMP_DEFAULT_TOTAL_SUPPLY && i.decimals === PUMP_TOKEN_DECIMALS;
  add('supply', 'Standard Pump.fun supply', !supplyOk, P.unexpectedSupply, `supply=${i.supply} decimals=${i.decimals}`);

  if (i.devInitialBuyPct !== null) {
    const big = i.devInitialBuyPct > P.devBigInitialBuyPct;
    add('dev_initial_buy', `Dev bought ≤ ${P.devBigInitialBuyPct}% at launch`, big, P.devBigInitialBuy, `Dev holds ${i.devInitialBuyPct.toFixed(2)}% of supply`);
  }

  add('creator_blacklist', 'Creator not blacklisted', i.creatorBlacklisted, P.blacklistedCreator, i.creatorBlacklisted ? 'Creator is on the blacklist' : 'Clean', true);

  // eslint-disable-next-line no-control-regex
  const weird = (s: string) => s.length === 0 || s.length > 64 || /[\u0000-\u001f]/.test(s);
  const nameBad = weird(i.name) || weird(i.symbol);
  add('name', 'Sane name / symbol', nameBad, P.suspiciousName, `"${i.name}" ($${i.symbol})`);

  const uriBad = !/^(https?|ipfs|ar):\/\//i.test(i.uri);
  add('metadata_uri', 'Has a metadata URI', uriBad, P.missingMetadataUri, i.uri || '(empty)');

  const penalty = checks.reduce((s, c) => s + c.penalty, 0);
  const hardFail = checks.some((c) => c.severity === 'FAIL');
  return {
    mint: i.mint,
    score: Math.max(0, 100 - penalty),
    hardFail,
    checks,
    checkedAt: new Date(),
    facts: {
      tokenProgram: i.owner,
      mintAuthority: i.mintAuthority,
      freezeAuthority: i.freezeAuthority,
      decimals: i.decimals,
      supplyRaw: i.supply.toString(),
      extensions: i.extensions,
      devInitialBuyPct: i.devInitialBuyPct,
    },
  };
}

export class SafetyChecker {
  constructor(private readonly liveState: LiveState) {}

  /**
   * Run all checks for one token, store the result and return it.
   * Throws only on transient errors (RPC down) so the job queue retries it.
   */
  async check(mint: string): Promise<SafetyReport> {
    const token = await prisma.token.findUnique({ where: { mint } });
    if (!token) throw new Error(`token ${mint} not in database`);

    const mintKey = new PublicKey(mint);
    const conn = getConnection();
    let info = await conn.getAccountInfo(mintKey, 'confirmed');
    if (!info) {
      // The RPC node we hit may be a slot behind the one that sent the log. Retry once.
      await new Promise((r) => setTimeout(r, 2_000));
      info = await conn.getAccountInfo(mintKey, 'confirmed');
    }
    if (!info) throw new Error(`mint account ${mint} not found yet`);

    const owner = info.owner.toBase58();
    let mintAuthority: string | null = null;
    let freezeAuthority: string | null = null;
    let decimals = -1;
    let supply = 0n;
    let extensions: string[] = [];
    if (owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID) {
      const parsed = unpackMint(mintKey, info, info.owner);
      mintAuthority = parsed.mintAuthority?.toBase58() ?? null;
      freezeAuthority = parsed.freezeAuthority?.toBase58() ?? null;
      decimals = parsed.decimals;
      supply = parsed.supply;
      extensions = getExtensionTypes(parsed.tlvData).map((t) => ExtensionType[t] ?? `Unknown(${t})`);
    }

    // Dev's holding right now ≈ their launch buy, since this runs seconds after creation.
    const live = await this.liveState.read(mint);
    const devInitialBuyPct = live ? (Number(live.balances.get(live.creator) ?? 0n) / Number(live.curve.totalSupply || 1n)) * 100 : null;

    const blacklisted = await prisma.blacklist.findFirst({
      where: { address: { in: [token.creator, mint] } },
      select: { address: true },
    });

    const report = evaluateSafety({
      mint,
      owner,
      mintAuthority,
      freezeAuthority,
      decimals,
      supply,
      extensions,
      name: token.name,
      symbol: token.symbol,
      uri: token.uri,
      devInitialBuyPct,
      creatorBlacklisted: blacklisted !== null,
    });

    await prisma.$transaction([
      prisma.safetyCheck.create({
        data: {
          mint,
          score: report.score,
          hardFail: report.hardFail,
          checks: report.checks as unknown as object,
          facts: report.facts as unknown as object,
          checkedAt: report.checkedAt,
        },
      }),
      prisma.token.update({ where: { mint }, data: { safetyScore: report.score, safetyHardFail: report.hardFail } }),
    ]);

    const failed = report.checks.filter((c) => c.severity !== 'PASS').map((c) => c.id);
    log.info(
      { mint, symbol: token.symbol, score: report.score, hardFail: report.hardFail, failed },
      report.hardFail ? 'safety: HARD FAIL' : `safety: ${report.score}/100`,
    );
    return report;
  }
}
