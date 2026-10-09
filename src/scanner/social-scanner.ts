/**
 * Social scanner — interface only for now (implemented in Phase 9).
 *
 * Any social source (Twitter/X, Telegram, ...) implements `SocialSource`.
 * The rest of the bot only ever talks to this interface, so plugging in the
 * Twitter API later means writing one class — nothing else changes.
 */

export interface SocialMention {
  source: 'twitter' | 'telegram';
  /** Token mint, if the post contained a contract address. */
  mint?: string;
  /** Cashtag / ticker mentioned, e.g. "PEPE". */
  ticker?: string;
  author: string;
  authorFollowers?: number;
  text: string;
  url?: string;
  postedAt: Date;
  engagement?: { likes: number; reposts: number; replies: number };
}

export interface SocialSource {
  readonly name: string;
  /** True if credentials are configured (e.g. TWITTER_BEARER_TOKEN is set). */
  isConfigured(): boolean;
  start(onMention: (m: SocialMention) => void): Promise<void>;
  stop(): Promise<void>;
  /** On-demand lookup: recent mentions of a mint or ticker. */
  search(query: { mint?: string; ticker?: string; sinceMinutes: number }): Promise<SocialMention[]>;
}

/** Used until a real source is connected: reports nothing, never fails. */
export class NullSocialSource implements SocialSource {
  readonly name = 'none';
  isConfigured(): boolean {
    return false;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async search(): Promise<SocialMention[]> {
    return [];
  }
}
