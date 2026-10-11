import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/config/env';
import { effectiveFeed, maskUrl, validateFeed } from '../src/lib/feed-settings';

const ENV = { DATA_SOURCE: 'hybrid', TRADES_WS_URL: 'wss://api.mainnet-beta.solana.com', GRPC_ENDPOINT: undefined, GRPC_TOKEN: undefined };

describe('data feed pasted on the dashboard', () => {
  it('accepts a Chainstack wss address and a gRPC endpoint, rejects junk', () => {
    const v = validateFeed({ tradesWsUrl: ' wss://solana-mainnet.core.chainstack.com/abcdef1234567890abcdef ' }, {});
    expect(v.ok && v.value.tradesWsUrl).toBe('wss://solana-mainnet.core.chainstack.com/abcdef1234567890abcdef');
    expect(validateFeed({ tradesWsUrl: 'https://not-a-socket' }, {}).ok).toBe(false);
    expect(validateFeed({ useGrpc: true }, {}).ok).toBe(false);
    const g = validateFeed({ grpcEndpoint: 'https://yellowstone-solana-mainnet.core.chainstack.com:443/', grpcToken: 'tok', useGrpc: true }, {});
    expect(g.ok && g.value.grpcEndpoint).toBe('https://yellowstone-solana-mainnet.core.chainstack.com:443');
    // Empty = back to the default.
    const back = validateFeed({ tradesWsUrl: '' }, { tradesWsUrl: 'wss://x' });
    expect(back.ok && back.value.tradesWsUrl).toBeNull();
  });
  it('dashboard settings win over the server file; gRPC only with an endpoint', () => {
    expect(effectiveFeed({}, ENV)).toMatchObject({ dataSource: 'hybrid', tradesWsUrl: ENV.TRADES_WS_URL });
    expect(effectiveFeed({ tradesWsUrl: 'wss://paid/x' }, ENV).tradesWsUrl).toBe('wss://paid/x');
    expect(effectiveFeed({ useGrpc: true, grpcEndpoint: 'https://g:443', grpcToken: 't' }, ENV)).toMatchObject({ dataSource: 'grpc', grpcEndpoint: 'https://g:443', grpcToken: 't' });
    expect(effectiveFeed({ useGrpc: false }, { ...ENV, DATA_SOURCE: 'grpc', GRPC_ENDPOINT: 'https://e:443' }).dataSource).toBe('hybrid');
  });
  it('never shows or logs the key', () => {
    const url = 'wss://solana-mainnet.core.chainstack.com/abcdef1234567890abcdef';
    expect(maskUrl(url)).toBe('wss://solana-mainnet.core.chainstack.com/••••');
    expect(redactUrl(url)).not.toContain('abcdef1234567890abcdef');
    expect(redactUrl('wss://mainnet.helius-rpc.com/?api-key=secret')).not.toContain('secret');
    expect(redactUrl('wss://user:pass@host.com/')).not.toContain('pass');
    expect(redactUrl('wss://api.mainnet-beta.solana.com')).toBe('wss://api.mainnet-beta.solana.com');
  });
});
