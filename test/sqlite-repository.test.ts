import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
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
  it('applies the initial migration once on a fresh database', () => {
    const path = tempDbPath();
    new SqliteFinanceRepository(path);
    expect(appliedVersions(path)).toEqual([1]);
  });

  it('is idempotent and preserves data when the database is reopened', () => {
    const path = tempDbPath();
    const first = new SqliteFinanceRepository(path);
    first.createAccount({ institution: 'Chase', name: 'Checking', type: 'checking', currency: 'USD' });

    const second = new SqliteFinanceRepository(path);

    expect(appliedVersions(path)).toEqual([1]);
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
