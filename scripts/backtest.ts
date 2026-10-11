/**
 * Replays archived trade tapes through the legacy and current rules.
 * Thin wrapper — the real code lives in src/cli/backtest.ts (compiled into the Docker image).
 *
 *   npm run backtest -- --days 7
 */
import '../src/cli/backtest';
