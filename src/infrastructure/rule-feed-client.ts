import type { RuleFeedClient } from '../application/ports.js';

// Transports the rule-feed document over HTTP(S). It only fetches bytes; parsing,
// validation, version gating, and upsert live in the application service so the
// same logic runs regardless of where the feed comes from (GitHub, a local static
// server in dev, or a stub in tests). See docs/rules-design.md § Over-the-air.
export class HttpRuleFeedClient implements RuleFeedClient {
  constructor(private readonly timeoutMs = 10_000) {}

  async fetchFeed(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Rule feed request failed (HTTP ${response.status})`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}
