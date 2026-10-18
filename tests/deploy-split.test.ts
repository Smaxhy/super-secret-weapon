/**
 * v15.4: crypto and forex run in separate containers and a push restarts only what it touches. These tests keep
 * scripts/forex-paths.txt honest: every file the forex process runs is listed, and nothing forex-only leaks into the
 * crypto bot.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { closure } = require('../scripts/deps-closure.cjs') as { closure: (entry: string) => string[] };
const rules = readFileSync('scripts/forex-paths.txt', 'utf8')
  .split('\n')
  .filter((l) => /^(only|shared) /.test(l))
  .map((l) => ({ kind: l.split(' ')[0]!, re: new RegExp(l.slice(l.indexOf(' ') + 1)) }));
const isOnly = (f: string) => rules.some((r) => r.kind === 'only' && r.re.test(f));
const isShared = (f: string) => rules.some((r) => r.kind === 'shared' && r.re.test(f));
const which = (files: string[]) => execFileSync('bash', ['scripts/which-containers.sh'], { input: files.join('\n') + '\n' }).toString().trim();

describe('crypto / forex deploy split (v15.4)', () => {
  const forex = closure('src/forex-main.ts');
  const crypto = closure('src/index.ts');

  it('every file the forex process runs is listed (forex-only or shared)', () => {
    const missing = forex.filter((f) => !isOnly(f) && !isShared(f));
    expect(missing).toEqual([]);
  });

  it('the crypto bot runs no forex-only file, and files both run are marked shared', () => {
    expect(crypto.filter(isOnly)).toEqual([]);
    const both = crypto.filter((f) => forex.includes(f));
    expect(both.filter((f) => !isShared(f))).toEqual([]);
    expect(crypto.length).toBeGreaterThan(50);
  });

  it('a push restarts only what it touches', () => {
    expect(which(['src/forex/lab.ts', 'CLAUDE.md'])).toBe('forex');
    expect(which(['src/api/forex-routes.ts'])).toBe('forex');
    expect(which(['src/scanner/whale-tracker.ts', 'tests/x.test.ts'])).toBe('crypto');
    expect(which(['src/config/migrations.ts'])).toBe('crypto');
    expect(which(['src/lib/logger.ts'])).toBe('crypto forex');
    expect(which(['package.json'])).toBe('crypto forex');
    expect(which(['docker-compose.yml'])).toBe('crypto forex');
    expect(which(['dashboard/src/App.tsx', 'docs/a.md', 'scripts/diagnose.sh'])).toBe('');
  });
});
