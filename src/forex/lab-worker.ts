/**
 * v17.2 child process for the hourly forex run (FX_LAB_WORKER=on). The parent forks it with its own heap limit, sends
 * the few things the run carries over between hours, gets back the run's output + the state the live bot needs, and
 * does the bot sync itself. The child never touches the bot account (it only reads its record) and never writes the
 * bot log. One run per process: it exits when done — and at once if the parent goes away (v17: IPC 'disconnect').
 */
import { redis } from '../lib/redis';
import { moduleLogger } from '../lib/logger';
import { ForexCalendar } from './calendar';
import { installSpreadProfiles } from './dukascopy';
import { feeds } from './feeds';
import { ForexHeadlines } from './headlines';
import { ForexLab, type WorkerInput, type WorkerResult } from './lab';
import { Practice } from './practice';

const log = moduleLogger('forex-lab-worker');

// v17: the parent died / dropped the channel (before 'run' or mid-run) → nobody will read the result: don't linger
process.on('disconnect', () => process.exit(0));

/** send the result, then exit (a closed channel still exits; a result that can't be sent throws to the caller) */
function finish(msg: WorkerResult, code: number): void {
  if (!process.send || !process.connected) process.exit(code);
  process.send(msg, () => process.exit(code));
}

process.on('message', (msg: { cmd: 'run'; refresh: boolean; input: WorkerInput }) => {
  if (msg?.cmd !== 'run') return;
  void (async () => {
    try {
      await feeds.load(redis);
      // v17: start with the parent's breakers (an open Yahoo breaker there is not ignored here)
      feeds.mergeBreakers(msg.input.breakers);
      await installSpreadProfiles(redis).catch(() => undefined);
      const lab = new ForexLab(redis, msg.input.universe ?? 'fx');
      lab.practice = new Practice(redis); // read-only here: the bot's record for the learner
      const cal = new ForexCalendar(redis);
      await cal.loadCached();
      lab.calendar = cal;
      const news = new ForexHeadlines(redis);
      await news.loadCached();
      lab.headlines = news;
      lab.importWorkerInput(msg.input);
      const out = await lab.computeRun(msg.refresh);
      const res: WorkerResult = { ok: true, out, state: lab.exportState(), feeds: feeds.snapshot(), breakers: feeds.breakerSnapshot() };
      finish(res, 0);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'forex lab worker failed');
      finish({ ok: false, error: (err as Error).message, feeds: feeds.snapshot(), breakers: feeds.breakerSnapshot() }, 1);
    }
  })();
});
process.send?.({ ready: true });
