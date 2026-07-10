import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalModelEngine } from '../src/infrastructure/local-model.js';

// Recency-window rules (large-transaction, executed-trades, duplicate-charge, …)
// filter on the transaction date against the real clock, so fixtures must be dated
// relative to now — a hardcoded date would silently fall out of the window and rot
// the test weeks later.
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// A models dir that will never contain weights, so the built-in engine reports
// every model as absent without touching the native runtime.
export function missingModelEngine() {
  return new LocalModelEngine(join(tmpdir(), 'finora-test-models-missing'));
}
