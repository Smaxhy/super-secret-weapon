/**
 * In-process event bus. Modules announce what happened; the WebSocket server
 * forwards it to connected dashboards. Nothing here ever throws back into the
 * module that emitted.
 */
import { EventEmitter } from 'node:events';

/** v17.12 (forex/practice.ts) */
export interface FxNotice {
  kind: 'lock' | 'run' | 'close';
  pair: string;
  side: 1 | -1;
  /** the trade's P&L now (close: its total, parts taken included) */
  pnlUsd: number;
  /** what it closes with if the stop is hit now */
  stopPnlUsd?: number | null;
  /** close: why (stop, target, signal, manual, stop-out) */
  reason?: string;
  strategy?: string | null;
}

export type BusEvent =
  | { type: 'token'; data: { mint: string; name: string; symbol: string; creator: string; createdAt: string } }
  | { type: 'safety'; data: { mint: string; score: number; hardFail: boolean } }
  | { type: 'evaluation'; data: { mint: string; symbol: string; score: number; decision: string; reasons: string[] } }
  | { type: 'trade'; data: { mint: string; symbol?: string; side: string; mode: string; amountSol: number; reason: string; pnlSol?: number; peakMultiple?: number; closed?: boolean; totalPnlSol?: number; explanation?: string | null } }
  | { type: 'stats'; data: Record<string, unknown> }
  | { type: 'fx'; data: { t: number; px: Record<string, [number, number, number, number]> } }
  /** v17.12: a forex trade worth a phone alert — its profit locked, ⅔ of the way to its target, or closed */
  | { type: 'fxTrade'; data: FxNotice & { acct: 'bot' | 'me' } }
  | { type: 'positions'; data: { updates: Array<{ id: string; priceSol: number; highSol?: number; multiple: number; peakMultiple: number; unrealizedPnlSol: number; risk: number; holders: number; ownSupplyPct: number; exitImpactPct: number }> } };

class Bus extends EventEmitter {
  publish(e: BusEvent): void {
    try {
      this.emit('event', e);
    } catch {
      // a broken listener must not break the publisher
    }
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
