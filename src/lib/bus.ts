/**
 * In-process event bus. Modules announce what happened; the WebSocket server
 * forwards it to connected dashboards. Nothing here ever throws back into the
 * module that emitted.
 */
import { EventEmitter } from 'node:events';

export type BusEvent =
  | { type: 'token'; data: { mint: string; name: string; symbol: string; creator: string; createdAt: string } }
  | { type: 'safety'; data: { mint: string; score: number; hardFail: boolean } }
  | { type: 'evaluation'; data: { mint: string; symbol: string; score: number; decision: string; reasons: string[] } }
  | { type: 'trade'; data: { mint: string; symbol?: string; side: string; mode: string; amountSol: number; reason: string; pnlSol?: number; peakMultiple?: number; closed?: boolean; totalPnlSol?: number } }
  | { type: 'stats'; data: Record<string, unknown> }
  | { type: 'positions'; data: { updates: Array<{ id: string; priceSol: number; multiple: number; peakMultiple: number; unrealizedPnlSol: number; risk: number; holders: number }> } };

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
