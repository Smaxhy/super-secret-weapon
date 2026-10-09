/**
 * Sanity check for your Helius setup — run with `npm run check:rpc`.
 *
 * 1. Calls getSlot over HTTP (is the API key valid?)
 * 2. Opens the WebSocket and listens to Pump.fun for 30 seconds, printing
 *    every launch it decodes. No database or Redis needed.
 */
import { env, redactUrl, rpcEndpoints } from '../src/config/env';
import { getConnection } from '../src/lib/solana';
import { PumpFunListener } from '../src/scanner/pumpfun-listener';

async function main(): Promise<void> {
  const { http, ws } = rpcEndpoints();
  if (!http || !ws) throw new Error('Set HELIUS_API_KEY in .env first');
  console.log(`HTTP: ${redactUrl(http)}\nWS:   ${redactUrl(ws)}\nmode: ${env.TRADING_MODE}\n`);

  const slot = await getConnection().getSlot();
  console.log(`✔ HTTP RPC works — current slot ${slot}`);

  const listener = new PumpFunListener(ws);
  listener.on('event', ({ event, signature }) => {
    if (event.kind === 'create') console.log(`🆕 ${event.symbol.padEnd(10)} ${event.name.slice(0, 30).padEnd(30)} ${event.mint}  tx ${signature.slice(0, 12)}…`);
    if (event.kind === 'complete') console.log(`🎓 curve complete ${event.mint}`);
  });
  listener.start();
  console.log('Listening to Pump.fun for 30s…\n');
  await new Promise((r) => setTimeout(r, 30_000));
  const s = listener.stats;
  console.log(`\n✔ ${s.notifications} txs seen, ${s.creates} launches, ${s.trades} trades, ${s.completes} completions, ${s.decodeErrors} decode errors`);
  await listener.stop();
  process.exit(0);
}

main().catch((err: Error) => {
  console.error('✖', err.message);
  process.exit(1);
});
