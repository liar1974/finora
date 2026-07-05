import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../application/errors.js';
import type {
  AccountCreate,
  AgentEventInput,
  FinanceRepository,
  ProviderBalanceInput,
  ProviderBrokerageTransactionInput,
  ProviderConnectionSave,
  ProviderHoldingInput,
  ProviderTransactionInput,
  SaveImportInput,
  SummaryQuery,
  TransactionQuery,
} from '../application/ports.js';
import type {
  Account,
  AccountBalance,
  AgentEventRecord,
  AgentEventType,
  AlertMuteRecord,
  AlertRuleRecord,
  AppSettingPreview,
  BrokerageHolding,
  BrokerageSummary,
  BrokerageTransaction,
  ChartArtifact,
  ChatSessionRecord,
  CreditReportRecord,
  DashboardRecord,
  ImportRecord,
  MoneySummary,
  Page,
  ProviderConnection,
  Transaction,
} from '../domain/models.js';

interface AccountRow extends Record<string, unknown> {
  id: string;
  institution: string;
  name: string;
  type: string;
  currency: string;
  domain: string;
  source: string;
  provider_account_id: string | null;
  metadata: string;
  created_at: string;
}

interface AgentEventRow extends Record<string, unknown> {
  id: string;
  turn_id: string;
  event_type: string;
  role: string | null;
  tool_name: string | null;
  content: string | null;
  payload: string;
  created_at: string;
}

interface TransactionRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  source_id: string | null;
  date: string;
  description: string;
  amount_minor: number;
  currency: string;
  category: string | null;
  pending: number;
  metadata: string;
  created_at: string;
}

interface ProviderConnectionRow extends Record<string, unknown> {
  id: string;
  provider: string;
  external_id: string;
  institution: string | null;
  status: string;
  environment: string | null;
  access_token: string | null;
  cursor: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface BrokerageTransactionRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  source_id: string | null;
  date: string;
  description: string;
  amount_minor: number;
  currency: string;
  symbol: string | null;
  investment_type: string | null;
  quantity: string | null;
  price_minor: number | null;
  category: string | null;
  metadata: string;
  created_at: string;
}

interface BrokerageHoldingRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  as_of_date: string;
  security_id: string | null;
  symbol: string | null;
  name: string | null;
  security_type: string | null;
  quantity: string | null;
  cost_basis_minor: number | null;
  price_minor: number | null;
  value_minor: number;
  currency: string;
  metadata: string;
  created_at: string;
}

interface AccountBalanceRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  as_of_date: string;
  current_minor: number;
  available_minor: number | null;
  limit_minor: number | null;
  cash_minor: number | null;
  buying_power_minor: number | null;
  currency: string;
  metadata: string;
  created_at: string;
}

interface DashboardRow extends Record<string, unknown> {
  id: string;
  public_id: string | null;
  name: string;
  layout: string;
  created_at: string;
  updated_at: string;
}

interface ChartArtifactRow extends Record<string, unknown> {
  id: string;
  public_id: string | null;
  name: string;
  artifact: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AppSettingRow extends Record<string, unknown> {
  key: string;
  value: string;
  updated_at: string;
}

interface CreditReportRow extends Record<string, unknown> {
  id: string;
  filename: string;
  content_hash: string;
  bureau: string | null;
  report_date: string | null;
  score: number | null;
  score_model: string | null;
  utilization_percent: number | null;
  total_balance_minor: number | null;
  total_limit_minor: number | null;
  accounts: number;
  open_accounts: number;
  delinquent_accounts: number;
  collections: number;
  inquiries: number;
  public_records: number;
  raw: string;
  bytes: number;
  created_at: string;
}

interface AlertRuleRow extends Record<string, unknown> {
  id: string;
  kind: string;
  source_text: string;
  scope: string;
  cadence: string;
  channel: string;
  scheduled_hour: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface AlertMuteRow extends Record<string, unknown> {
  id: string;
  kind: string | null;
  account_id: string | null;
  label: string | null;
  expires_at: string | null;
  created_at: string;
}

interface ImportRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  filename: string;
  format: string;
  content_hash: string;
  inserted_count: number;
  skipped_count: number;
  created_at: string;
}

export class SqliteFinanceRepository implements FinanceRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.migrate(path);
  }

  createAccount(input: AccountCreate): Account {
    const account: Account = {
      id: randomUUID(),
      institution: input.institution,
      name: input.name,
      type: input.type,
      currency: input.currency,
      domain: input.domain ?? 'bank',
      source: input.source ?? 'files',
      providerAccountId: input.providerAccountId ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    try {
      this.database.exec('BEGIN IMMEDIATE');
      this.database.prepare(`
          INSERT INTO accounts (
            id, institution, name, type, currency, domain, source,
            provider_account_id, metadata, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          account.id,
          account.institution,
          account.name,
          account.type,
          account.currency,
          account.domain,
          account.source,
          account.providerAccountId,
          JSON.stringify(account.metadata),
          account.createdAt,
        );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AppError('conflict', 'An account with this institution and name already exists');
      }
      throw error;
    }
    return account;
  }

  listAccounts(): Account[] {
    const rows = this.database.prepare(`
      SELECT id, institution, name, type, currency, domain, source,
             provider_account_id, metadata, created_at
      FROM accounts ORDER BY institution, name, id
    `).all() as AccountRow[];
    return rows.map(mapAccount);
  }

  getAccount(id: string): Account | null {
    const row = this.database.prepare(`
      SELECT id, institution, name, type, currency, domain, source,
             provider_account_id, metadata, created_at
      FROM accounts WHERE id = ?
    `).get(id) as AccountRow | undefined;
    return row ? mapAccount(row) : null;
  }

  removeAccount(id: string): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const table of [
        'transactions',
        'imports',
        'brokerage_transactions',
        'brokerage_holdings',
        'account_balances',
      ]) {
        this.database.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(id);
      }
      const result = this.database.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      this.database.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listTransactions(query: TransactionQuery): Page<Transaction> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.accountId) {
      clauses.push('account_id = ?');
      values.push(query.accountId);
    }
    if (query.from) {
      clauses.push('date >= ?');
      values.push(query.from);
    }
    if (query.to) {
      clauses.push('date <= ?');
      values.push(query.to);
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      clauses.push('(date < ? OR (date = ? AND id < ?))');
      values.push(cursor.date, cursor.date, cursor.id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT id, account_id, source_id, date, description, amount_minor,
             currency, category, pending, metadata, created_at
      FROM transactions ${where}
      ORDER BY date DESC, id DESC
      LIMIT ?
    `).all(...values, query.limit + 1) as TransactionRow[];
    const hasNext = rows.length > query.limit;
    const pageRows = hasNext ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(mapTransaction),
      nextCursor: hasNext && last ? encodeCursor(last.date, last.id) : null,
    };
  }

  summarize(query: SummaryQuery): MoneySummary[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (query.accountId) {
      clauses.push('account_id = ?');
      values.push(query.accountId);
    }
    if (query.from) {
      clauses.push('date >= ?');
      values.push(query.from);
    }
    if (query.to) {
      clauses.push('date <= ?');
      values.push(query.to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT currency,
        COALESCE(SUM(CASE WHEN amount_minor > 0 THEN amount_minor ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN amount_minor < 0 THEN -amount_minor ELSE 0 END), 0) AS expense,
        COALESCE(SUM(amount_minor), 0) AS net
      FROM transactions ${where}
      GROUP BY currency ORDER BY currency
    `).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      currency: String(row.currency),
      incomeMinor: Number(row.income),
      expenseMinor: Number(row.expense),
      netMinor: Number(row.net),
    }));
  }

  listProviderConnections(): ProviderConnection[] {
    const rows = this.database.prepare(`
      SELECT id, provider, external_id, institution, status, environment,
             access_token, cursor, metadata, created_at, updated_at
      FROM provider_connections
      ORDER BY provider, institution, external_id
    `).all() as ProviderConnectionRow[];
    return rows.map(mapProviderConnection);
  }

  getProviderConnectionSecret(provider: string, externalId: string): { accessToken: string | null; cursor: string | null; metadata: Record<string, unknown> } | null {
    const row = this.database.prepare(`
      SELECT access_token, cursor, metadata
      FROM provider_connections
      WHERE provider = ? AND external_id = ?
    `).get(provider.trim().toLowerCase(), externalId.trim()) as Pick<ProviderConnectionRow, 'access_token' | 'cursor' | 'metadata'> | undefined;
    return row ? { accessToken: row.access_token, cursor: row.cursor, metadata: parseJsonObject(row.metadata) } : null;
  }

  saveProviderConnection(input: ProviderConnectionSave): ProviderConnection {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const connection = this.saveProviderConnectionInTransaction(input, now);
      this.database.exec('COMMIT');
      return connection;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listBrokerageTransactions(query: TransactionQuery): Page<BrokerageTransaction> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.accountId) {
      clauses.push('account_id = ?');
      values.push(query.accountId);
    }
    if (query.from) {
      clauses.push('date >= ?');
      values.push(query.from);
    }
    if (query.to) {
      clauses.push('date <= ?');
      values.push(query.to);
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      clauses.push('(date < ? OR (date = ? AND id < ?))');
      values.push(cursor.date, cursor.date, cursor.id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT id, account_id, source_id, date, description, amount_minor,
             currency, symbol, investment_type, quantity, price_minor,
             category, metadata, created_at
      FROM brokerage_transactions ${where}
      ORDER BY date DESC, id DESC
      LIMIT ?
    `).all(...values, query.limit + 1) as BrokerageTransactionRow[];
    const hasNext = rows.length > query.limit;
    const pageRows = hasNext ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(mapBrokerageTransaction),
      nextCursor: hasNext && last ? encodeCursor(last.date, last.id) : null,
    };
  }

  listBrokerageHoldings(accountId?: string): BrokerageHolding[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (accountId) {
      clauses.push('account_id = ?');
      values.push(accountId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT id, account_id, as_of_date, security_id, symbol, name,
             security_type, quantity, cost_basis_minor, price_minor,
             value_minor, currency, metadata, created_at
      FROM (
        SELECT id, account_id, as_of_date, security_id, symbol, name,
               security_type, quantity, cost_basis_minor, price_minor,
               value_minor, currency, metadata, created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY account_id, COALESCE(security_id, symbol, name, security_type, ''), currency
                 ORDER BY as_of_date DESC, created_at DESC, id DESC
               ) AS holding_rank
        FROM brokerage_holdings ${where}
      )
      WHERE holding_rank = 1
      ORDER BY value_minor DESC, symbol, id
    `).all(...values) as BrokerageHoldingRow[];
    return rows.map(mapBrokerageHolding);
  }

  listAccountBalances(accountId?: string): AccountBalance[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (accountId) {
      clauses.push('account_id = ?');
      values.push(accountId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT id, account_id, as_of_date, current_minor, available_minor,
             limit_minor, cash_minor, buying_power_minor, currency,
             metadata, created_at
      FROM account_balances ${where}
      ORDER BY as_of_date DESC, account_id, id
    `).all(...values) as AccountBalanceRow[];
    return rows.map(mapAccountBalance);
  }

  summarizeBrokerage(): BrokerageSummary[] {
    const rows = this.database.prepare(`
      SELECT currency,
        COALESCE(SUM(value_minor), 0) AS market_value,
        COALESCE((SELECT SUM(cash_minor) FROM (
          SELECT account_id, currency, cash_minor
          FROM account_balances b
          WHERE b.cash_minor IS NOT NULL
            AND b.as_of_date = (
              SELECT MAX(b2.as_of_date)
              FROM account_balances b2
              WHERE b2.account_id = b.account_id
            )
        ) latest WHERE latest.currency = brokerage_holdings.currency), 0) AS cash,
        COALESCE((SELECT SUM(buying_power_minor) FROM (
          SELECT account_id, currency, buying_power_minor
          FROM account_balances b
          WHERE b.buying_power_minor IS NOT NULL
            AND b.as_of_date = (
              SELECT MAX(b2.as_of_date)
              FROM account_balances b2
              WHERE b2.account_id = b.account_id
            )
        ) latest WHERE latest.currency = brokerage_holdings.currency), 0) AS buying_power,
        COUNT(*) AS holdings,
        COALESCE((SELECT COUNT(*) FROM brokerage_transactions tx
          WHERE tx.currency = brokerage_holdings.currency), 0) AS transactions
      FROM brokerage_holdings
      WHERE as_of_date = (
        SELECT MAX(h2.as_of_date)
        FROM brokerage_holdings h2
        WHERE h2.account_id = brokerage_holdings.account_id
      )
      GROUP BY currency
      ORDER BY currency
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      currency: String(row.currency),
      marketValueMinor: Number(row.market_value),
      cashMinor: Number(row.cash),
      buyingPowerMinor: Number(row.buying_power),
      holdings: Number(row.holdings),
      transactions: Number(row.transactions),
    }));
  }

  listDashboards(): DashboardRecord[] {
    const artifacts = (this.database.prepare(`
      SELECT id, public_id, name, artifact, version, created_at, updated_at
      FROM chart_artifacts
      ORDER BY updated_at DESC, name
    `).all() as ChartArtifactRow[]).map(mapChartArtifact);
    const rows = this.database.prepare(`
      SELECT id, public_id, name, layout, created_at, updated_at
      FROM dashboards
      ORDER BY updated_at DESC, name
    `).all() as DashboardRow[];
    return rows.map((row) => ({ ...mapDashboard(row), artifacts }));
  }

  listCreditReports(): CreditReportRecord[] {
    const rows = this.database.prepare(`
      SELECT id, filename, content_hash, bureau, report_date, score, score_model,
             utilization_percent, total_balance_minor, total_limit_minor, accounts,
             open_accounts, delinquent_accounts, collections, inquiries, public_records,
             raw, bytes, created_at
      FROM credit_reports
      ORDER BY created_at DESC, filename
    `).all() as CreditReportRow[];
    return rows.map(mapCreditReport);
  }

  saveCreditReport(input: Omit<CreditReportRecord, 'id' | 'createdAt'>): CreditReportRecord {
    const now = new Date().toISOString();
    const row: CreditReportRecord = { id: randomUUID(), createdAt: now, ...input };
    this.database.prepare(`
      INSERT INTO credit_reports (
        id, filename, content_hash, bureau, report_date, score, score_model,
        utilization_percent, total_balance_minor, total_limit_minor, accounts,
        open_accounts, delinquent_accounts, collections, inquiries, public_records,
        raw, bytes, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.filename, row.contentHash, row.bureau, row.reportDate, row.score, row.scoreModel,
      row.utilizationPercent, row.totalBalanceMinor, row.totalLimitMinor, row.accounts,
      row.openAccounts, row.delinquentAccounts, row.collections, row.inquiries, row.publicRecords,
      JSON.stringify(row.raw), row.bytes, row.createdAt,
    );
    return row;
  }

  removeCreditReport(id: string): boolean {
    const result = this.database.prepare('DELETE FROM credit_reports WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listAppSettings(keys?: string[]): AppSettingPreview[] {
    const allow = keys?.filter((key) => /^[A-Z0-9_]+$/.test(key));
    const rows = allow?.length
      ? this.database.prepare(`
          SELECT key, value, updated_at FROM app_settings
          WHERE key IN (${allow.map(() => '?').join(',')})
          ORDER BY key
        `).all(...allow) as AppSettingRow[]
      : this.database.prepare(`
          SELECT key, value, updated_at FROM app_settings
          ORDER BY key
        `).all() as AppSettingRow[];
    return rows.map(mapAppSetting);
  }

  getAppSetting(key: string): string | null {
    const row = this.database.prepare(`
      SELECT value FROM app_settings WHERE key = ?
    `).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  saveAppSettings(entries: Record<string, string>): void {
    const upsert = this.database.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(entries)) {
        upsert.run(key, value, now);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listAlertRules(): AlertRuleRecord[] {
    const rows = this.database.prepare(`
      SELECT id, kind, source_text, scope, cadence, channel, scheduled_hour, enabled, created_at, updated_at
      FROM alert_rules
      ORDER BY enabled DESC, cadence, scope, created_at DESC
    `).all() as AlertRuleRow[];
    return rows.map(mapAlertRule);
  }

  saveAlertRule(input: Omit<AlertRuleRecord, 'id' | 'createdAt' | 'updatedAt'>): AlertRuleRecord {
    const now = new Date().toISOString();
    const row: AlertRuleRecord = { id: randomUUID(), createdAt: now, updatedAt: now, ...input };
    this.database.prepare(`
      INSERT INTO alert_rules (id, kind, source_text, scope, cadence, channel, scheduled_hour, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.kind, row.sourceText, row.scope, row.cadence, row.channel, row.scheduledHour, row.enabled ? 1 : 0, now, now);
    return row;
  }

  toggleAlertRule(id: string, enabled: boolean): AlertRuleRecord | null {
    this.database.prepare(`
      UPDATE alert_rules SET enabled = ?, updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, new Date().toISOString(), id);
    const row = this.database.prepare(`
      SELECT id, kind, source_text, scope, cadence, channel, scheduled_hour, enabled, created_at, updated_at
      FROM alert_rules WHERE id = ?
    `).get(id) as AlertRuleRow | undefined;
    return row ? mapAlertRule(row) : null;
  }

  removeAlertRule(id: string): boolean {
    const result = this.database.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listAlertMutes(): AlertMuteRecord[] {
    const rows = this.database.prepare(`
      SELECT id, kind, account_id, label, expires_at, created_at
      FROM alert_mutes
      ORDER BY created_at DESC
    `).all() as AlertMuteRow[];
    return rows.map(mapAlertMute);
  }

  saveAlertMute(input: Omit<AlertMuteRecord, 'id' | 'createdAt'>): AlertMuteRecord {
    const row: AlertMuteRecord = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.database.prepare(`
      INSERT INTO alert_mutes (id, kind, account_id, label, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, row.kind, row.accountId, row.label, row.expiresAt, row.createdAt);
    return row;
  }

  removeAlertMute(id: string): boolean {
    const result = this.database.prepare('DELETE FROM alert_mutes WHERE id = ?').run(id);
    return result.changes > 0;
  }

  findImport(accountId: string, contentHash: string): ImportRecord | null {
    const row = this.database.prepare(`
      SELECT id, account_id, filename, format, content_hash, inserted_count,
             skipped_count, created_at FROM imports
      WHERE account_id = ? AND content_hash = ?
    `).get(accountId, contentHash) as ImportRow | undefined;
    return row ? mapImport(row) : null;
  }

  saveImport(input: SaveImportInput): ImportRecord {
    const record: ImportRecord = {
      id: randomUUID(),
      accountId: input.account.id,
      filename: input.filename,
      format: input.format,
      contentHash: input.contentHash,
      insertedCount: 0,
      skippedCount: 0,
      createdAt: new Date().toISOString(),
    };
    const insertTransaction = this.database.prepare(`
      INSERT OR IGNORE INTO transactions (
        id, account_id, source_id, date, description, amount_minor, currency,
        category, pending, metadata, fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const transaction of input.transactions) {
        const result = insertTransaction.run(
          randomUUID(),
          input.account.id,
          transaction.sourceId ?? null,
          transaction.date,
          transaction.description,
          transaction.amountMinor,
          input.account.currency,
          transaction.category ?? null,
          transaction.pending ? 1 : 0,
          JSON.stringify(transaction.metadata ?? {}),
          transaction.fingerprint,
          record.createdAt,
        );
        if (result.changes === 1) record.insertedCount += 1;
        else record.skippedCount += 1;
      }
      this.database.prepare(`
        INSERT INTO imports (
          id, account_id, filename, format, content_hash, inserted_count,
          skipped_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.accountId,
        record.filename,
        record.format,
        record.contentHash,
        record.insertedCount,
        record.skippedCount,
        record.createdAt,
      );
      this.database.exec('COMMIT');
      return record;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  reconcileProviderTransactions(transactions: ProviderTransactionInput[]): { inserted: number; updated: number; skipped: number } {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO transactions (
        id, account_id, source_id, date, description, amount_minor, currency,
        category, pending, metadata, fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const findRow = this.database.prepare(
      'SELECT id FROM transactions WHERE account_id = ? AND fingerprint = ?',
    );
    const update = this.database.prepare(`
      UPDATE transactions SET
        source_id = ?, date = ?, description = ?, amount_minor = ?, currency = ?,
        category = ?, pending = ?, metadata = ?, fingerprint = ?
      WHERE id = ?
    `);
    const deleteById = this.database.prepare('DELETE FROM transactions WHERE id = ?');
    const result = { inserted: 0, updated: 0, skipped: 0 };
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const transaction of transactions) {
        const supersedes = transaction.supersedesFingerprint;
        if (supersedes) {
          const pendingRow = findRow.get(transaction.accountId, supersedes) as { id: string } | undefined;
          if (pendingRow) {
            const postedRow = findRow.get(transaction.accountId, transaction.fingerprint) as { id: string } | undefined;
            if (postedRow && postedRow.id !== pendingRow.id) {
              // The posted transaction is already stored under its own row; drop
              // the now-obsolete pending row so the ledger keeps a single entry.
              deleteById.run(pendingRow.id);
            } else {
              update.run(
                transaction.sourceId ?? null,
                transaction.date,
                transaction.description,
                transaction.amountMinor,
                transaction.currency,
                transaction.category ?? null,
                transaction.pending ? 1 : 0,
                JSON.stringify(transaction.metadata ?? {}),
                transaction.fingerprint,
                pendingRow.id,
              );
            }
            result.updated += 1;
            continue;
          }
        }
        const inserted = insert.run(
          randomUUID(),
          transaction.accountId,
          transaction.sourceId ?? null,
          transaction.date,
          transaction.description,
          transaction.amountMinor,
          transaction.currency,
          transaction.category ?? null,
          transaction.pending ? 1 : 0,
          JSON.stringify(transaction.metadata ?? {}),
          transaction.fingerprint,
          now,
        ).changes === 1;
        if (inserted) result.inserted += 1;
        else result.skipped += 1;
      }
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  deleteTransactionsByFingerprints(accountId: string, fingerprints: string[]): number {
    if (fingerprints.length === 0) return 0;
    const placeholders = fingerprints.map(() => '?').join(', ');
    const statement = this.database.prepare(
      `DELETE FROM transactions WHERE account_id = ? AND fingerprint IN (${placeholders})`,
    );
    return Number(statement.run(accountId, ...fingerprints).changes);
  }

  saveProviderBrokerageTransactions(transactions: ProviderBrokerageTransactionInput[]): { inserted: number; skipped: number } {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO brokerage_transactions (
        id, account_id, source_id, date, description, amount_minor, currency,
        symbol, investment_type, quantity, price_minor, category, metadata,
        fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.insertBatch(transactions, (transaction, now) => insert.run(
      randomUUID(),
      transaction.accountId,
      transaction.sourceId ?? null,
      transaction.date,
      transaction.description,
      transaction.amountMinor,
      transaction.currency,
      transaction.symbol ?? null,
      transaction.investmentType ?? null,
      transaction.quantity ?? null,
      transaction.priceMinor ?? null,
      transaction.category ?? null,
      JSON.stringify(transaction.metadata ?? {}),
      transaction.fingerprint,
      now,
    ).changes === 1);
  }

  saveProviderHoldings(holdings: ProviderHoldingInput[]): { inserted: number; skipped: number } {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO brokerage_holdings (
        id, account_id, as_of_date, security_id, symbol, name, security_type,
        quantity, cost_basis_minor, price_minor, value_minor, currency, metadata,
        fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.insertBatch(holdings, (holding, now) => insert.run(
      randomUUID(),
      holding.accountId,
      holding.asOfDate,
      holding.securityId ?? null,
      holding.symbol ?? null,
      holding.name ?? null,
      holding.securityType ?? null,
      holding.quantity ?? null,
      holding.costBasisMinor ?? null,
      holding.priceMinor ?? null,
      holding.valueMinor,
      holding.currency,
      JSON.stringify(holding.metadata ?? {}),
      holding.fingerprint,
      now,
    ).changes === 1);
  }

  saveProviderBalances(balances: ProviderBalanceInput[]): { inserted: number; skipped: number } {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO account_balances (
        id, account_id, as_of_date, current_minor, available_minor, limit_minor,
        cash_minor, buying_power_minor, currency, metadata, fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.insertBatch(balances, (balance, now) => insert.run(
      randomUUID(),
      balance.accountId,
      balance.asOfDate,
      balance.currentMinor,
      balance.availableMinor ?? null,
      balance.limitMinor ?? null,
      balance.cashMinor ?? null,
      balance.buyingPowerMinor ?? null,
      balance.currency,
      JSON.stringify(balance.metadata ?? {}),
      balance.fingerprint,
      now,
    ).changes === 1);
  }

  close(): void {
    this.database.close();
  }

  private insertBatch<T>(items: T[], insert: (item: T, now: string) => boolean): { inserted: number; skipped: number } {
    const result = { inserted: 0, skipped: 0 };
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        if (insert(item, now)) result.inserted += 1;
        else result.skipped += 1;
      }
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(databasePath: string): void {
    // The schema_migrations ledger records which numbered migrations have run.
    // Each migration below is applied exactly once, in order, inside its own
    // transaction. Adding a new migration (new tables, ALTER TABLE, backfills)
    // is as simple as appending an entry with the next version number; it will
    // run automatically on the first launch of a build that ships it, which is
    // what makes the desktop auto-update safe across schema changes.
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = new Set(
      (
        this.database.prepare('SELECT version FROM schema_migrations').all() as {
          version: number | bigint;
        }[]
      ).map((row) => Number(row.version)),
    );

    const migrations: { version: number; up: () => void }[] = [
      { version: 1, up: () => this.applyInitialSchema() },
      { version: 2, up: () => this.applyAgentMemorySchema() },
      { version: 3, up: () => this.applyChatSessionsSchema() },
    ];

    // Before mutating an existing user's data, snapshot it. This only runs when
    // there is real data to protect (an already-migrated database) AND pending
    // migrations — never on a fresh install. A migration that corrupts data via
    // faulty backfill logic still commits, so this is the only recovery path.
    const pending = migrations.some((migration) => !applied.has(migration.version));
    if (pending && applied.size > 0 && databasePath !== ':memory:') {
      this.backupBeforeMigrating(databasePath, Math.max(...applied));
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.database.exec('BEGIN IMMEDIATE');
      try {
        migration.up();
        this.database
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }

    // Indexes are declared IF NOT EXISTS, so reconcile them on every startup to
    // cover databases created before a given index was introduced.
    this.ensureIndexes();
  }

  private backupBeforeMigrating(databasePath: string, fromVersion: number): void {
    const backupPath = `${databasePath}.backup-v${fromVersion}`;
    try {
      // A leftover backup at this path means a previous migration attempt from
      // the same schema version rolled back; overwriting it is safe because the
      // source state is identical.
      rmSync(backupPath, { force: true });
      // VACUUM INTO writes a single, consistent snapshot that already folds in
      // any WAL contents, so there is no need to copy the -wal/-shm sidecars.
      this.database.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    } catch (error) {
      // Refuse to migrate without a recoverable backup: leaving the data
      // untouched (and surfacing why) is safer than mutating it unprotected.
      throw new Error(
        `Could not back up the database before migrating (${backupPath}). Free up disk space or check permissions and relaunch. Original error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private applyInitialSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        institution TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        currency TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'bank',
        source TEXT NOT NULL DEFAULT 'files',
        provider_account_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (institution, name)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        source_id TEXT,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        category TEXT,
        pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
        metadata TEXT NOT NULL DEFAULT '{}',
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, fingerprint)
      );

      CREATE INDEX IF NOT EXISTS transactions_date_id_idx
        ON transactions(date DESC, id DESC);
      CREATE INDEX IF NOT EXISTS transactions_account_date_idx
        ON transactions(account_id, date DESC);

      CREATE TABLE IF NOT EXISTS imports (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        format TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        inserted_count INTEGER NOT NULL,
        skipped_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, content_hash)
      );

      CREATE TABLE IF NOT EXISTS provider_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        institution TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        environment TEXT,
        access_token TEXT,
        cursor TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider, external_id)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS brokerage_transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        source_id TEXT,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        symbol TEXT,
        investment_type TEXT,
        quantity TEXT,
        price_minor INTEGER,
        category TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, fingerprint)
      );

      CREATE INDEX IF NOT EXISTS brokerage_transactions_date_id_idx
        ON brokerage_transactions(date DESC, id DESC);
      CREATE INDEX IF NOT EXISTS brokerage_transactions_account_date_idx
        ON brokerage_transactions(account_id, date DESC);

      CREATE TABLE IF NOT EXISTS brokerage_holdings (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        as_of_date TEXT NOT NULL,
        security_id TEXT,
        symbol TEXT,
        name TEXT,
        security_type TEXT,
        quantity TEXT,
        cost_basis_minor INTEGER,
        price_minor INTEGER,
        value_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, fingerprint)
      );

      CREATE INDEX IF NOT EXISTS brokerage_holdings_asof_idx
        ON brokerage_holdings(as_of_date DESC);
      CREATE INDEX IF NOT EXISTS brokerage_holdings_symbol_idx
        ON brokerage_holdings(symbol);

      CREATE TABLE IF NOT EXISTS account_balances (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        as_of_date TEXT NOT NULL,
        current_minor INTEGER NOT NULL,
        available_minor INTEGER,
        limit_minor INTEGER,
        cash_minor INTEGER,
        buying_power_minor INTEGER,
        currency TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, fingerprint)
      );

      CREATE INDEX IF NOT EXISTS account_balances_asof_idx
        ON account_balances(as_of_date DESC);

      CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY,
        public_id TEXT,
        name TEXT NOT NULL,
        layout TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (public_id)
      );

      CREATE TABLE IF NOT EXISTS chart_artifacts (
        id TEXT PRIMARY KEY,
        public_id TEXT,
        name TEXT NOT NULL,
        artifact TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (public_id)
      );

      CREATE TABLE IF NOT EXISTS credit_reports (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        bureau TEXT,
        report_date TEXT,
        score INTEGER,
        score_model TEXT,
        utilization_percent REAL,
        total_balance_minor INTEGER,
        total_limit_minor INTEGER,
        accounts INTEGER NOT NULL DEFAULT 0,
        open_accounts INTEGER NOT NULL DEFAULT 0,
        delinquent_accounts INTEGER NOT NULL DEFAULT 0,
        collections INTEGER NOT NULL DEFAULT 0,
        inquiries INTEGER NOT NULL DEFAULT 0,
        public_records INTEGER NOT NULL DEFAULT 0,
        raw TEXT NOT NULL DEFAULT '{}',
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (content_hash)
      );

      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_text TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'banking',
        cadence TEXT NOT NULL DEFAULT 'event',
        channel TEXT NOT NULL DEFAULT 'auto',
        scheduled_hour INTEGER CHECK (scheduled_hour IS NULL OR (scheduled_hour >= 0 AND scheduled_hour <= 23)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS alert_rules_enabled_idx
        ON alert_rules(enabled);

      CREATE TABLE IF NOT EXISTS alert_mutes (
        id TEXT PRIMARY KEY,
        kind TEXT,
        account_id TEXT,
        label TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO app_settings(key, value, updated_at)
      VALUES
        ('LLM_PROVIDER', 'builtin', datetime('now')),
        ('LLM_BASE_URL', '', datetime('now')),
        ('LLM_MODEL', 'qwen2.5-3b-instruct', datetime('now')),
        ('LLM_CHAT_MODEL', 'qwen2.5-3b-instruct', datetime('now'));
    `);
  }

  private applyChatSessionsSchema(): void {
    // Durable conversation state for inbound chat channels (e.g. Telegram DM).
    // One row per session key; the reset policy rotates session_id and clears
    // messages while the row (and its started_at) persists across restarts.
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_interaction_at TEXT NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  getChatSession(sessionKey: string): ChatSessionRecord | null {
    const row = this.database
      .prepare(`
        SELECT session_key, session_id, started_at, last_interaction_at, messages
        FROM chat_sessions WHERE session_key = ?
      `)
      .get(sessionKey) as
      | { session_key: string; session_id: string; started_at: string; last_interaction_at: string; messages: string }
      | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.messages);
    return {
      sessionKey: row.session_key,
      sessionId: row.session_id,
      startedAt: row.started_at,
      lastInteractionAt: row.last_interaction_at,
      messages: Array.isArray(parsed) ? parsed : [],
    };
  }

  saveChatSession(record: ChatSessionRecord): void {
    this.database
      .prepare(`
        INSERT INTO chat_sessions(session_key, session_id, started_at, last_interaction_at, messages)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          session_id = excluded.session_id,
          started_at = excluded.started_at,
          last_interaction_at = excluded.last_interaction_at,
          messages = excluded.messages
      `)
      .run(
        record.sessionKey,
        record.sessionId,
        record.startedAt,
        record.lastInteractionAt,
        JSON.stringify(record.messages),
      );
  }

  private applyAgentMemorySchema(): void {
    // Agent memory. The user profile is one rewritten markdown document;
    // agent_events is an append-only interaction log enforced by triggers
    // (SQLite's analogue of a Postgres append-only trigger); reflection_state is
    // the cursor the reflection job advances.
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id TEXT PRIMARY KEY DEFAULT 'default',
        markdown TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        role TEXT,
        tool_name TEXT,
        content TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_events_created_idx ON agent_events(created_at);
      CREATE INDEX IF NOT EXISTS agent_events_turn_idx ON agent_events(turn_id);

      CREATE TRIGGER IF NOT EXISTS agent_events_no_update
        BEFORE UPDATE ON agent_events
        BEGIN SELECT RAISE(ABORT, 'agent_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS agent_events_no_delete
        BEFORE DELETE ON agent_events
        BEGIN SELECT RAISE(ABORT, 'agent_events is append-only'); END;

      CREATE TABLE IF NOT EXISTS reflection_state (
        id TEXT PRIMARY KEY DEFAULT 'default',
        last_reflected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  getUserProfileMarkdown(): string | null {
    const row = this.database
      .prepare("SELECT markdown FROM user_profiles WHERE id = 'default'")
      .get() as { markdown: string } | undefined;
    return row ? row.markdown : null;
  }

  saveUserProfileMarkdown(markdown: string): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO user_profiles(id, markdown, created_at, updated_at)
        VALUES ('default', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at
      `)
      .run(markdown, now, now);
  }

  appendAgentEvent(input: AgentEventInput): void {
    this.database
      .prepare(`
        INSERT INTO agent_events(id, turn_id, event_type, role, tool_name, content, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        input.turnId,
        input.eventType,
        input.role ?? null,
        input.toolName ?? null,
        input.content ?? null,
        JSON.stringify(input.payload ?? {}),
        new Date().toISOString(),
      );
  }

  listAgentEventsSince(since: string | null, until: string): AgentEventRecord[] {
    // rowid is monotonic with insertion, so it breaks created_at ties back into
    // true chronological order (events within one turn share a millisecond).
    const rows = (
      since
        ? this.database
            .prepare(
              'SELECT * FROM agent_events WHERE created_at > ? AND created_at <= ? ORDER BY created_at ASC, rowid ASC',
            )
            .all(since, until)
        : this.database
            .prepare('SELECT * FROM agent_events WHERE created_at <= ? ORDER BY created_at ASC, rowid ASC')
            .all(until)
    ) as AgentEventRow[];
    return rows.map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      eventType: row.event_type as AgentEventType,
      role: row.role,
      toolName: row.tool_name,
      content: row.content,
      payload: parseJsonObject(row.payload),
      createdAt: row.created_at,
    }));
  }

  getReflectionCursor(): string | null {
    const row = this.database
      .prepare("SELECT last_reflected_at FROM reflection_state WHERE id = 'default'")
      .get() as { last_reflected_at: string | null } | undefined;
    return row ? row.last_reflected_at : null;
  }

  setReflectionCursor(at: string): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO reflection_state(id, last_reflected_at, created_at, updated_at)
        VALUES ('default', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_reflected_at = excluded.last_reflected_at, updated_at = excluded.updated_at
      `)
      .run(at, now, now);
  }

  private saveProviderConnectionInTransaction(input: ProviderConnectionSave, now: string): ProviderConnection {
    const provider = input.provider.trim().toLowerCase();
    const externalId = input.externalId.trim();
    if (!provider || !externalId) {
      throw new AppError('invalid_input', 'Provider connection requires provider and externalId');
    }

    const existing = this.database.prepare(`
      SELECT id, provider, external_id, institution, status, environment,
             access_token, cursor, metadata, created_at, updated_at
      FROM provider_connections
      WHERE provider = ? AND external_id = ?
    `).get(provider, externalId) as ProviderConnectionRow | undefined;
    const metadata = mergeProviderMetadata(
      existing ? parseJsonObject(existing.metadata) : {},
      input.metadata ?? {},
    );
    const id = existing?.id ?? randomUUID();

    this.database.prepare(`
      INSERT INTO provider_connections (
        id, provider, external_id, institution, status, environment,
        access_token, cursor, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, external_id) DO UPDATE SET
        institution = excluded.institution,
        status = excluded.status,
        environment = excluded.environment,
        access_token = excluded.access_token,
        cursor = excluded.cursor,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      id,
      provider,
      externalId,
      input.institution ?? existing?.institution ?? null,
      input.status?.trim() || existing?.status || 'active',
      input.environment ?? existing?.environment ?? null,
      input.accessToken ?? existing?.access_token ?? null,
      input.cursor ?? existing?.cursor ?? null,
      JSON.stringify(metadata),
      existing?.created_at ?? now,
      now,
    );

    const row = this.database.prepare(`
      SELECT id, provider, external_id, institution, status, environment,
             access_token, cursor, metadata, created_at, updated_at
      FROM provider_connections WHERE id = ?
    `).get(id) as ProviderConnectionRow | undefined;
    if (!row) throw new AppError('invalid_input', 'Provider connection was not saved');
    return mapProviderConnection(row);
  }


  private ensureIndexes(): void {
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS transactions_date_id_idx
        ON transactions(date DESC, id DESC);
      CREATE INDEX IF NOT EXISTS transactions_account_date_idx
        ON transactions(account_id, date DESC);
      CREATE INDEX IF NOT EXISTS brokerage_transactions_date_id_idx
        ON brokerage_transactions(date DESC, id DESC);
      CREATE INDEX IF NOT EXISTS brokerage_transactions_account_date_idx
        ON brokerage_transactions(account_id, date DESC);
      CREATE INDEX IF NOT EXISTS brokerage_holdings_asof_idx
        ON brokerage_holdings(as_of_date DESC);
      CREATE INDEX IF NOT EXISTS brokerage_holdings_symbol_idx
        ON brokerage_holdings(symbol);
      CREATE INDEX IF NOT EXISTS account_balances_asof_idx
        ON account_balances(as_of_date DESC);
    `);
  }
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    institution: row.institution,
    name: row.name,
    type: row.type,
    currency: row.currency,
    domain: row.domain,
    source: row.source,
    providerAccountId: row.provider_account_id,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
  };
}

function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    accountId: row.account_id,
    sourceId: row.source_id,
    date: row.date,
    description: row.description,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    category: row.category,
    pending: row.pending === 1,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
  };
}

function mapProviderConnection(row: ProviderConnectionRow): ProviderConnection {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    institution: row.institution,
    status: row.status,
    environment: row.environment,
    hasAccessToken: Boolean(row.access_token),
    hasCursor: Boolean(row.cursor),
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mergeProviderMetadata(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing, ...incoming };
  const accountIds = [
    ...metadataStringArray(existing.accountIds),
    ...metadataStringArray(incoming.accountIds),
  ];
  if (accountIds.length) merged.accountIds = [...new Set(accountIds)];
  return merged;
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function mapBrokerageTransaction(row: BrokerageTransactionRow): BrokerageTransaction {
  return {
    id: row.id,
    accountId: row.account_id,
    sourceId: row.source_id,
    date: row.date,
    description: row.description,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    symbol: row.symbol,
    investmentType: row.investment_type,
    quantity: row.quantity,
    priceMinor: nullableNumber(row.price_minor),
    category: row.category,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
  };
}

function mapBrokerageHolding(row: BrokerageHoldingRow): BrokerageHolding {
  return {
    id: row.id,
    accountId: row.account_id,
    asOfDate: row.as_of_date,
    securityId: row.security_id,
    symbol: row.symbol,
    name: row.name,
    securityType: row.security_type,
    quantity: row.quantity,
    costBasisMinor: nullableNumber(row.cost_basis_minor),
    priceMinor: nullableNumber(row.price_minor),
    valueMinor: Number(row.value_minor),
    currency: row.currency,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
  };
}

function mapAccountBalance(row: AccountBalanceRow): AccountBalance {
  return {
    id: row.id,
    accountId: row.account_id,
    asOfDate: row.as_of_date,
    currentMinor: Number(row.current_minor),
    availableMinor: nullableNumber(row.available_minor),
    limitMinor: nullableNumber(row.limit_minor),
    cashMinor: nullableNumber(row.cash_minor),
    buyingPowerMinor: nullableNumber(row.buying_power_minor),
    currency: row.currency,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
  };
}

function mapDashboard(row: DashboardRow): Omit<DashboardRecord, 'artifacts'> {
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    layout: parseJson(row.layout, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChartArtifact(row: ChartArtifactRow): ChartArtifact {
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    artifact: parseJson(row.artifact, {}),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCreditReport(row: CreditReportRow): CreditReportRecord {
  return {
    id: row.id,
    filename: row.filename,
    contentHash: row.content_hash,
    bureau: row.bureau,
    reportDate: row.report_date,
    score: nullableNumber(row.score),
    scoreModel: row.score_model,
    utilizationPercent: nullableNumber(row.utilization_percent),
    totalBalanceMinor: nullableNumber(row.total_balance_minor),
    totalLimitMinor: nullableNumber(row.total_limit_minor),
    accounts: Number(row.accounts || 0),
    openAccounts: Number(row.open_accounts || 0),
    delinquentAccounts: Number(row.delinquent_accounts || 0),
    collections: Number(row.collections || 0),
    inquiries: Number(row.inquiries || 0),
    publicRecords: Number(row.public_records || 0),
    raw: parseJsonObject(row.raw),
    bytes: Number(row.bytes || 0),
    createdAt: row.created_at,
  };
}

function mapAppSetting(row: AppSettingRow): AppSettingPreview {
  const secret = /KEY|SECRET|TOKEN|PASSWORD/i.test(row.key);
  return {
    key: row.key,
    set: row.value.length > 0,
    preview: secret ? mask(row.value) : row.value,
    secret,
    updatedAt: row.updated_at,
  };
}

function mapAlertRule(row: AlertRuleRow): AlertRuleRecord {
  return {
    id: row.id,
    kind: row.kind,
    sourceText: row.source_text,
    scope: row.scope,
    cadence: row.cadence,
    channel: row.channel,
    scheduledHour: typeof row.scheduled_hour === 'number' ? row.scheduled_hour : null,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAlertMute(row: AlertMuteRow): AlertMuteRecord {
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.account_id,
    label: row.label,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapImport(row: ImportRow): ImportRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    filename: row.filename,
    format: row.format,
    contentHash: row.content_hash,
    insertedCount: Number(row.inserted_count),
    skippedCount: Number(row.skipped_count),
    createdAt: row.created_at,
  };
}

function encodeCursor(date: string, id: string): string {
  return Buffer.from(JSON.stringify({ date, id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { date: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      !('date' in value) ||
      !('id' in value) ||
      typeof value.date !== 'string' ||
      typeof value.id !== 'string'
    ) throw new Error('shape');
    return { date: value.date, id: value.id };
  } catch {
    throw new AppError('invalid_input', 'cursor is invalid');
  }
}

function nullableNumber(value: number | null): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJson(value, {});
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
