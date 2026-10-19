/**
 * v17.2 child process for the hourly forex run (FX_LAB_WORKER=on). The parent forks it with its own heap limit, sends
 * the few things the run carries over between hours, gets back the run's output + the state the live bot needs, and
 * does the bot sync itself. The child never touches the bot account (it only reads its record) and never writes the
 * bot log. One run per process: it exits when done.
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

process.on('message', (msg: { cmd: 'run'; refresh: boolean; input: WorkerInput }) => {
  if (msg?.cmd !== 'run') return;
  void (async () => {
    try {
      await feeds.load(redis);
      await installSpreadProfiles(redis).catch(() => undefined);
      const lab = new ForexLab(redis);
      lab.practice = new Practice(redis); // read-only here: the bot's record for the learner
      const cal = new ForexCalendar(redis);
      await cal.loadCached();
      lab.calendar = cal;
      const news = new ForexHeadlines(redis);
      await news.loadCached();
      lab.headlines = news;
      lab.importWorkerInput(msg.input);
      const out = await lab.computeRun(msg.refresh);
      const res: WorkerResult = { ok: true, out, state: lab.exportState(), feeds: feeds.snapshot() };
      process.send!(res, () => process.exit(0));
    } catch (err) {
      log.error({ err: (err as Error).message }, 'forex lab worker failed');
      process.send!({ ok: false, error: (err as Error).message } satisfies WorkerResult, () => process.exit(1));
    }
  })();
});
process.send?.({ ready: true });
