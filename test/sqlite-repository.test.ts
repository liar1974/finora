import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { dailyResetBoundary } from '../src/application/finance-service.js';
import { SqliteFinanceRepository } from '../src/infrastructure/sqlite-repository.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'finora-repo-'));
  tempDirs.push(dir);
  return join(dir, 'finora.db');
}

function appliedVersions(path: string): number[] {
  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
    version: number | bigint;
  }[];
  db.close();
  return rows.map((row) => Number(row.version));
}

// Force migration 1 to look unapplied on a populated database: build a full v1
// database with real data, then rewrite the ledger so a migration is pending
// while existing data (and every table) remains. This is the only way to
// exercise the "pending migration on an existing install" path with a single
// migration defined in production.
function seedPendingMigrationWithData(path: string): void {
  const repo = new SqliteFinanceRepository(path);
  repo.createAccount({ institution: 'Chase', name: 'Checking', type: 'checking', currency: 'USD' });
  const db = new DatabaseSync(path);
  db.exec("INSERT INTO schema_migrations(version, applied_at) VALUES (99, '2026-01-01T00:00:00Z')");
  db.exec('DELETE FROM schema_migrations WHERE version = 1');
  db.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SqliteFinanceRepository migrations', () => {
  it('applies all migrations once on a fresh database', () => {
    const path = tempDbPath();
    new SqliteFinanceRepository(path);
    expect(appliedVersions(path)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('is idempotent and preserves data when the database is reopened', () => {
    const path = tempDbPath();
    const first = new SqliteFinanceRepository(path);
    first.createAccount({ institution: 'Chase', name: 'Checking', type: 'checking', currency: 'USD' });

    const second = new SqliteFinanceRepository(path);

    expect(appliedVersions(path)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(second.listAccounts().map((account) => account.name)).toContain('Checking');
  });

  it('does not create a backup on a fresh install', () => {
    const path = tempDbPath();
    new SqliteFinanceRepository(path);
    expect(existsSync(`${path}.backup-v0`)).toBe(false);
    expect(existsSync(`${path}.backup-v1`)).toBe(false);
  });
});

describe('SqliteFinanceRepository pre-migration backup', () => {
  it('snapshots existing data before applying a pending migration', () => {
    const path = tempDbPath();
    seedPendingMigrationWithData(path);

    new SqliteFinanceRepository(path); // reopen -> migration 1 pending -> backup, then apply

    const backup = `${path}.backup-v99`;
    expect(existsSync(backup)).toBe(true);

    // The backup is a standalone, consistent snapshot (VACUUM INTO folds in WAL),
    // so it opens without the -wal/-shm sidecars and holds the pre-migration data.
    const snapshot = new DatabaseSync(backup);
    const names = (snapshot.prepare('SELECT name FROM accounts').all() as { name: string }[]).map(
      (row) => row.name,
    );
    snapshot.close();
    expect(names).toContain('Checking');

    // The live database finished the migration.
    expect(appliedVersions(path)).toContain(1);
  });

  it('refuses to migrate (throws, leaves data unmutated) when the backup fails', () => {
    const path = tempDbPath();
    seedPendingMigrationWithData(path);

    // A directory where the snapshot file must go makes the backup step fail.
    mkdirSync(`${path}.backup-v99`);

    expect(() => new SqliteFinanceRepository(path)).toThrow(/back up the database/i);
    // The pending migration was never applied, so the data is untouched.
    expect(appliedVersions(path)).not.toContain(1);
  });
});

describe('SqliteFinanceRepository chat sessions', () => {
  it('returns null for an unknown session key', () => {
    const repo = new SqliteFinanceRepository(tempDbPath());
    expect(repo.getChatSession('telegram:owner')).toBeNull();
  });

  it('round-trips a session and persists it across reopen', () => {
    const path = tempDbPath();
    const record = {
      sessionKey: 'telegram:owner',
      sessionId: 'session-1',
      startedAt: '2026-07-05T09:00:00.000Z',
      lastInteractionAt: '2026-07-05T09:05:00.000Z',
      messages: [
        { role: 'user' as const, content: 'how much did I spend?' },
        { role: 'assistant' as const, content: '$123.45' },
      ],
    };
    new SqliteFinanceRepository(path).saveChatSession(record);

    // A new repository instance (as after a backend restart) still sees it.
    const reopened = new SqliteFinanceRepository(path).getChatSession('telegram:owner');
    expect(reopened).toEqual(record);
  });

  it('upserts on the same session key', () => {
    const path = tempDbPath();
    const repo = new SqliteFinanceRepository(path);
    repo.saveChatSession({
      sessionKey: 'telegram:owner',
      sessionId: 'old',
      startedAt: '2026-07-04T09:00:00.000Z',
      lastInteractionAt: '2026-07-04T09:00:00.000Z',
      messages: [{ role: 'user', content: 'first' }],
    });
    repo.saveChatSession({
      sessionKey: 'telegram:owner',
      sessionId: 'new',
      startedAt: '2026-07-05T09:00:00.000Z',
      lastInteractionAt: '2026-07-05T09:00:00.000Z',
      messages: [],
    });
    const session = repo.getChatSession('telegram:owner');
    expect(session?.sessionId).toBe('new');
    expect(session?.messages).toEqual([]);
  });
});

describe('dailyResetBoundary', () => {
  it('returns today 04:00 when now is after it', () => {
    const now = new Date('2026-07-05T10:30:00');
    const boundary = dailyResetBoundary(now);
    expect(boundary.getDate()).toBe(now.getDate());
    expect(boundary.getHours()).toBe(4);
    expect(boundary.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('rolls back to the previous day when now is before 04:00', () => {
    const now = new Date('2026-07-05T02:00:00');
    const boundary = dailyResetBoundary(now);
    expect(boundary.getDate()).toBe(4); // yesterday's 04:00
    expect(boundary.getHours()).toBe(4);
    expect(boundary.getTime()).toBeLessThan(now.getTime());
  });

  it('treats a session started before the boundary as stale, and after as fresh', () => {
    const now = new Date('2026-07-05T10:00:00');
    const boundary = dailyResetBoundary(now).getTime();
    expect(new Date('2026-07-04T22:00:00').getTime() < boundary).toBe(true);
    expect(new Date('2026-07-05T08:00:00').getTime() < boundary).toBe(false);
  });
});

describe('SqliteFinanceRepository brokerageValueSeries', () => {
  it('sums holdings market value per date with as-of carry-forward and excludes non-brokerage accounts', () => {
    const repo = new SqliteFinanceRepository(tempDbPath());
    const a = repo.createAccount({ institution: 'Fidelity', name: 'Brokerage A', type: 'brokerage', currency: 'USD', domain: 'brokerage' });
    const b = repo.createAccount({ institution: 'Schwab', name: 'Brokerage B', type: 'brokerage', currency: 'USD', domain: 'brokerage' });
    const bank = repo.createAccount({ institution: 'Chase', name: 'Checking', type: 'checking', currency: 'USD', domain: 'bank' });

    repo.saveProviderHoldings([
      // A's 01-01 snapshot is two positions that must sum to one account total (1000).
      { accountId: a.id, asOfDate: '2026-01-01', symbol: 'AAPL', valueMinor: 600, currency: 'USD', fingerprint: 'a:AAPL:2026-01-01' },
      { accountId: a.id, asOfDate: '2026-01-01', symbol: 'MSFT', valueMinor: 400, currency: 'USD', fingerprint: 'a:MSFT:2026-01-01' },
      // A re-syncs on 01-03 with a new full snapshot (1200).
      { accountId: a.id, asOfDate: '2026-01-03', symbol: 'AAPL', valueMinor: 1200, currency: 'USD', fingerprint: 'a:AAPL:2026-01-03' },
      { accountId: b.id, asOfDate: '2026-01-02', symbol: 'VOO', valueMinor: 500, currency: 'USD', fingerprint: 'b:VOO:2026-01-02' },
      // A holding on a non-brokerage account must never leak into the equity curve.
      { accountId: bank.id, asOfDate: '2026-01-02', symbol: 'XXX', valueMinor: 999999, currency: 'USD', fingerprint: 'bank:XXX:2026-01-02' },
    ]);

    const series = repo.brokerageValueSeries();

    expect(series).toEqual([
      // Only A has synced yet (600 + 400).
      { date: '2026-01-01', valueMinor: 1000, currency: 'USD' },
      // A carried forward from 01-01 (1000) + B's first snapshot (500). Bank excluded.
      { date: '2026-01-02', valueMinor: 1500, currency: 'USD' },
      // A's new snapshot (1200) + B carried forward from 01-02 (500).
      { date: '2026-01-03', valueMinor: 1700, currency: 'USD' },
    ]);
  });

  it('narrows to a single account when accountId is given', () => {
    const repo = new SqliteFinanceRepository(tempDbPath());
    const a = repo.createAccount({ institution: 'Fidelity', name: 'Brokerage A', type: 'brokerage', currency: 'USD', domain: 'brokerage' });
    const b = repo.createAccount({ institution: 'Schwab', name: 'Brokerage B', type: 'brokerage', currency: 'USD', domain: 'brokerage' });
    repo.saveProviderHoldings([
      { accountId: a.id, asOfDate: '2026-01-01', symbol: 'AAPL', valueMinor: 1000, currency: 'USD', fingerprint: 'a:AAPL:2026-01-01' },
      { accountId: b.id, asOfDate: '2026-01-01', symbol: 'VOO', valueMinor: 500, currency: 'USD', fingerprint: 'b:VOO:2026-01-01' },
    ]);
    expect(repo.brokerageValueSeries(a.id)).toEqual([
      { date: '2026-01-01', valueMinor: 1000, currency: 'USD' },
    ]);
  });

  it('returns an empty series when there are no brokerage holdings', () => {
    const repo = new SqliteFinanceRepository(tempDbPath());
    repo.createAccount({ institution: 'Chase', name: 'Checking', type: 'checking', currency: 'USD', domain: 'bank' });
    expect(repo.brokerageValueSeries()).toEqual([]);
  });

  it('excludes cash pseudo-holdings (Plaid CUR:USD) from the equity curve', () => {
    const repo = new SqliteFinanceRepository(tempDbPath());
    const a = repo.createAccount({ institution: 'Robinhood', name: 'Individual', type: 'brokerage', currency: 'USD', domain: 'brokerage' });
    repo.saveProviderHoldings([
      { accountId: a.id, asOfDate: '2026-01-01', symbol: 'AAPL', securityType: 'equity', valueMinor: 1000, currency: 'USD', fingerprint: 'a:AAPL:2026-01-01' },
      { accountId: a.id, asOfDate: '2026-01-01', symbol: 'CUR:USD', securityType: 'cash', valueMinor: 8302256, currency: 'USD', fingerprint: 'a:cash:2026-01-01' },
    ]);
    expect(repo.brokerageValueSeries()).toEqual([
      { date: '2026-01-01', valueMinor: 1000, currency: 'USD' },
    ]);
  });
});

describe('SqliteFinanceRepository summarizeBrokerage cash handling', () => {
  it('treats cash pseudo-holdings as cash and falls back to balance cash_minor', () => {
    const repo = new SqliteFinanceRepository(tempDbPath());
    // Plaid-style account: cash arrives as a CUR:USD holding, no balance cash_minor.
    const plaid = repo.createAccount({ institution: 'Robinhood', name: 'Individual', type: 'brokerage', currency: 'USD', domain: 'brokerage' });
    // SnapTrade-style account: cash_minor on the balance, no cash holding.
    const snap = repo.createAccount({ institution: 'Alpaca', name: 'Margin', type: 'brokerage', currency: 'USD', domain: 'brokerage' });

    repo.saveProviderHoldings([
      { accountId: plaid.id, asOfDate: '2026-01-01', symbol: 'AAPL', securityType: 'equity', costBasisMinor: 800, valueMinor: 1000, currency: 'USD', fingerprint: 'p:AAPL' },
      { accountId: plaid.id, asOfDate: '2026-01-01', symbol: 'CUR:USD', securityType: 'cash', valueMinor: 500, currency: 'USD', fingerprint: 'p:cash' },
      { accountId: snap.id, asOfDate: '2026-01-01', symbol: 'VOO', securityType: 'etf', costBasisMinor: 300, valueMinor: 400, currency: 'USD', fingerprint: 's:VOO' },
    ]);
    repo.saveProviderBalances([
      { accountId: snap.id, asOfDate: '2026-01-01', currentMinor: 600, cashMinor: 200, buyingPowerMinor: 250, currency: 'USD', fingerprint: 's:bal' },
    ]);

    const summary = repo.summarizeBrokerage()[0]!;
    // Market value excludes the cash holding: 1000 (AAPL) + 400 (VOO).
    expect(summary.marketValueMinor).toBe(1400);
    // Cash = cash holding (500) + snap balance cash_minor (200).
    expect(summary.cashMinor).toBe(700);
    expect(summary.buyingPowerMinor).toBe(250);
    // Holdings count excludes the cash pseudo-holding: AAPL + VOO.
    expect(summary.holdings).toBe(2);
  });

  it('treats a crypto-exchange CUR:USD line as market value, not cash', () => {
    const repo = new SqliteFinanceRepository(tempDbPath());
    const stocks = repo.createAccount({ institution: 'Robinhood', name: 'Individual', type: 'brokerage', currency: 'USD', domain: 'brokerage' });
    const crypto = repo.createAccount({ institution: 'Robinhood', name: 'Crypto', type: 'crypto exchange', currency: 'USD', domain: 'brokerage' });
    repo.saveProviderHoldings([
      { accountId: stocks.id, asOfDate: '2026-01-01', symbol: 'AAPL', securityType: 'equity', costBasisMinor: 800, valueMinor: 1000, currency: 'USD', fingerprint: 'st:AAPL' },
      { accountId: stocks.id, asOfDate: '2026-01-01', symbol: 'CUR:USD', securityType: 'cash', valueMinor: 500, currency: 'USD', fingerprint: 'st:cash' },
      // Crypto exchange: Plaid reports the whole balance as a CUR:USD cash line.
      { accountId: crypto.id, asOfDate: '2026-01-01', symbol: 'CUR:USD', securityType: 'cash', valueMinor: 7000, currency: 'USD', fingerprint: 'cx:cash' },
    ]);

    const summary = repo.summarizeBrokerage()[0]!;
    // Market value = AAPL (1000) + crypto CUR:USD (7000); the stock account's real
    // cash (500) stays out.
    expect(summary.marketValueMinor).toBe(8000);
    // Cash = only the stock account's cash line, not the crypto balance.
    expect(summary.cashMinor).toBe(500);
    // Holdings counts AAPL + crypto line, not the stock cash line.
    expect(summary.holdings).toBe(2);

    // Equity curve includes the crypto value but not the stock cash.
    const point = repo.brokerageValueSeries()[0]!;
    expect(point).toEqual({ date: '2026-01-01', valueMinor: 8000, currency: 'USD' });
  });

  it('drops stale holdings when a newer balance snapshot shows the account was emptied', () => {
    const repo = new SqliteFinanceRepository(tempDbPath());
    const held = repo.createAccount({ institution: 'Robinhood', name: 'Individual', type: 'brokerage', currency: 'USD', domain: 'brokerage' });
    const emptied = repo.createAccount({ institution: 'Robinhood', name: 'Crypto', type: 'crypto exchange', currency: 'USD', domain: 'brokerage' });
    repo.saveProviderHoldings([
      { accountId: held.id, asOfDate: '2026-01-02', symbol: 'AAPL', securityType: 'equity', valueMinor: 1000, currency: 'USD', fingerprint: 'h:AAPL:02' },
      // Emptied account: last holdings snapshot on 01-01, then a 01-02 sync with no holdings.
      { accountId: emptied.id, asOfDate: '2026-01-01', symbol: 'CUR:USD', securityType: 'cash', valueMinor: 7000, currency: 'USD', fingerprint: 'e:cash:01' },
    ]);
    repo.saveProviderBalances([
      { accountId: held.id, asOfDate: '2026-01-02', currentMinor: 1000, currency: 'USD', fingerprint: 'h:bal:02' },
      { accountId: emptied.id, asOfDate: '2026-01-01', currentMinor: 7000, currency: 'USD', fingerprint: 'e:bal:01' },
      { accountId: emptied.id, asOfDate: '2026-01-02', currentMinor: 0, currency: 'USD', fingerprint: 'e:bal:02' },
    ]);

    // Market value counts only the still-held account; the emptied one is dropped.
    const summary = repo.summarizeBrokerage()[0]!;
    expect(summary.marketValueMinor).toBe(1000);
    expect(summary.holdings).toBe(1);

    // The equity curve shows the emptied account historically, then drops to 0.
    expect(repo.brokerageValueSeries(emptied.id)).toEqual([
      { date: '2026-01-01', valueMinor: 7000, currency: 'USD' },
      { date: '2026-01-02', valueMinor: 0, currency: 'USD' },
    ]);
  });

  it('setBrokerageCashMinor patches cash onto an existing balance snapshot', () => {
    const repo = new SqliteFinanceRepository(tempDbPath());
    const a = repo.createAccount({ institution: 'Robinhood', name: 'Individual', type: 'brokerage', currency: 'USD', domain: 'brokerage' });
    repo.saveProviderBalances([
      { accountId: a.id, asOfDate: '2026-01-01', currentMinor: 1000, currency: 'USD', fingerprint: 'a:bal:2026-01-01' },
    ]);
    repo.setBrokerageCashMinor(a.id, '2026-01-01', 500);
    const balance = repo.listAccountBalances(a.id).find((row) => row.asOfDate === '2026-01-01');
    expect(balance?.cashMinor).toBe(500);
  });
});
