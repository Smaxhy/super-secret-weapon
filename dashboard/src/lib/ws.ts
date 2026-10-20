/**
 * v22.1: the same pages serve two desks — the forex bot (`#/forex/…`, API `/api/forex/*`, bot account 'bot') and the
 * coin bot (`#/crypto/…`, API `/api/crypto/*`, bot account 'cbot'). Which one a page belongs to is read from the route,
 * so a component never needs a prop for it. Account-agnostic routes (practice, P&L, calendar, feeds) stay under
 * `/api/forex/*` and take the account id.
 */
export const inCrypto = (): boolean => (typeof location !== 'undefined' ? location.hash.startsWith('#/crypto') : false);
/** the lab + auto-bot API of this desk */
export const apiBase = (): string => (inCrypto() ? '/api/crypto' : '/api/forex');
/** the route prefix of this desk's pages */
export const wsBase = (): string => (inCrypto() ? '/crypto' : '/forex');
/** this desk's auto-bot practice account */
export const botAcct = (): 'bot' | 'cbot' => (inCrypto() ? 'cbot' : 'bot');
/** plain name of this desk's bot for copy */
export const deskName = (): string => (inCrypto() ? 'coin bot' : 'forex bot');
