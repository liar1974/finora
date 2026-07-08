import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
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
  RuleAdoption,
  SaveImportInput,
  SummaryQuery,
  TransactionQuery,
} from '../application/ports.js';
import type {
  Account,
  AccountBalance,
  AgentEventRecord,
  AgentEventType,
  AppSettingPreview,
  BrokerageHolding,
  BrokerageSummary,
  BrokerageTransaction,
  ChartArtifact,
  ChatSessionRecord,
  CreditReportRecord,
  DashboardRecord,
  FactRecord,
  FindingMuteRecord,
  ImportRecord,
  MerchantCandidate,
  MerchantIdentity,
  MoneySummary,
  Page,
  ProviderConnection,
  QuestionRecord,
  RecurringCandidate,
  RecurringClassification,
  RuleRecord,
  RuleSpec,
  Transaction,
} from '../domain/models.js';

// Shared by the fresh-install baseline and the v4 reset migration so both paths
// converge on the same rules-engine schema. Findings are computed on read and not
// persisted; only rule specs, user facts, pending questions, and mutes are stored.
const RULES_ENGINE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT 'cash-flow',
    source_text TEXT NOT NULL,
    execution_class TEXT NOT NULL DEFAULT 'D' CHECK (execution_class IN ('D', 'L', 'L+')),
    action_tier TEXT NOT NULL DEFAULT 'observer' CHECK (action_tier IN ('observer', 'advisor', 'guardian', 'navigator')),
    scope TEXT NOT NULL DEFAULT 'banking',
    cadence TEXT NOT NULL DEFAULT 'event',
    channel TEXT NOT NULL DEFAULT 'auto',
    scheduled_hour INTEGER CHECK (scheduled_hour IS NULL OR (scheduled_hour >= 0 AND scheduled_hour <= 23)),
    scheduled_day INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS rules_enabled_idx ON rules(enabled);

  CREATE TABLE IF NOT EXISTS facts (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'derived', 'reference')),
    confidence REAL NOT NULL DEFAULT 0.7,
    refresh_after TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    fact_key TEXT NOT NULL UNIQUE,
    prompt TEXT NOT NULL,
    rule_kind TEXT NOT NULL,
    unlock_impact_minor INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    suggested_value TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'dismissed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS finding_mutes (
    id TEXT PRIMARY KEY,
    kind TEXT,
    account_id TEXT,
    label TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL
  );
`;

// Rule definitions as data. Built-in specs are seeded here on startup; downloaded
// specs upsert into the same table, so the engine reads all rules from data.
const RULE_SPECS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS rule_specs (
    kind TEXT PRIMARY KEY,
    domain TEXT NOT NULL DEFAULT 'cash-flow',
    execution_class TEXT NOT NULL DEFAULT 'D',
    action_tier TEXT NOT NULL DEFAULT 'observer',
    scope TEXT NOT NULL DEFAULT 'banking',
    cadence TEXT NOT NULL DEFAULT 'event',
    always_on INTEGER NOT NULL DEFAULT 0 CHECK (always_on IN (0, 1)),
    keywords TEXT NOT NULL DEFAULT '',
    sql TEXT,
    prompt TEXT,
    facts TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'builtin',
    updated_at TEXT NOT NULL
  );
`;

// The single rules table (migration v12): one row per rule carrying BOTH the
// definition (code/feed owned) and the user's on/off + schedule (user owned).
// Replaces the former rule_specs (definitions) + rules (instances) split. `kind`
// is identity; the engine runs a row when enabled AND active. (The always_on and
// user_rule columns here are created for the v12/v13 fold and dropped in v15.)
const MERGED_RULES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS rules (
    kind TEXT PRIMARY KEY,
    domain TEXT NOT NULL DEFAULT 'cash-flow',
    execution_class TEXT NOT NULL DEFAULT 'D' CHECK (execution_class IN ('D', 'L', 'L+')),
    action_tier TEXT NOT NULL DEFAULT 'observer' CHECK (action_tier IN ('observer', 'advisor', 'guardian', 'navigator')),
    scope TEXT NOT NULL DEFAULT 'banking',
    cadence TEXT NOT NULL DEFAULT 'event',
    always_on INTEGER NOT NULL DEFAULT 0 CHECK (always_on IN (0, 1)),
    keywords TEXT NOT NULL DEFAULT '',
    sql TEXT,
    prompt TEXT,
    facts TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'builtin',
    user_rule INTEGER NOT NULL DEFAULT 0 CHECK (user_rule IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    source_text TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'auto',
    scheduled_hour INTEGER CHECK (scheduled_hour IS NULL OR (scheduled_hour >= 0 AND scheduled_hour <= 23)),
    scheduled_day INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS rules_run_idx ON rules(enabled, always_on, active);
`;

// LLM verdicts on whether a merchant series is recurring, keyed by normalized
// merchant + direction (account-agnostic — a merchant is recurring regardless of
// which card paid it). Populated by an out-of-band classification pass so the
// synchronous rules engine and the recurring view can just JOIN this table. The
// signature captures the series shape at classification time; when it changes
// materially the row is re-classified.
const RECURRING_CLASSIFICATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS recurring_classifications (
    merchant TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    is_recurring INTEGER NOT NULL DEFAULT 0 CHECK (is_recurring IN (0, 1)),
    kind TEXT,
    cadence TEXT,
    canonical_name TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    signature TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (merchant, direction)
  );
`;

// F1 merchant identity. Maps each normalized merchant to a canonical vendor so
// rules can group by vendor across differing billing descriptions. Keyed by the
// normalized merchant; canonical_slug is the shared lowercased join key.
const MERCHANT_IDENTITIES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS merchant_identities (
    merchant TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    canonical_slug TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    signature TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

// Backing implementations for the SQL rule primitives. Kept in the infrastructure
// layer alongside the connection they are registered on.
const FEE_TOKEN_PATTERN = /\b(fee|fees|overdraft|nsf|service charge|atm|late charge|late fee|interest charge|finance charge|maintenance fee|surcharge|annual fee)\b/i;

function moneyValue(minor: unknown, currency: unknown): string {
  const amount = Number(minor ?? 0) / 100;
  const code = String(currency || 'USD');
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

function normalizeMerchantValue(description: unknown): string {
  return String(description ?? '')
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z一-鿿 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

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

interface RuleRow extends Record<string, unknown> {
  kind: string;
  domain: string;
  execution_class: string;
  action_tier: string;
  scope: string;
  cadence: string;
  keywords: string;
  sql: string | null;
  prompt: string | null;
  facts: string;
  enabled: number;
  version: number;
  source: string;
  active: number;
  source_text: string;
  channel: string;
  scheduled_hour: number | null;
  scheduled_day: number | null;
  created_at: string;
  updated_at: string;
}

interface FindingMuteRow extends Record<string, unknown> {
  id: string;
  kind: string | null;
  account_id: string | null;
  label: string | null;
  expires_at: string | null;
  created_at: string;
}

interface RuleSpecRow extends Record<string, unknown> {
  kind: string;
  domain: string;
  execution_class: string;
  action_tier: string;
  scope: string;
  cadence: string;
  keywords: string;
  sql: string | null;
  prompt: string | null;
  facts: string;
  enabled: number;
  version: number;
  source: string;
}

interface FactRow extends Record<string, unknown> {
  key: string;
  value: string;
  source: string;
  confidence: number;
  refresh_after: string | null;
  updated_at: string;
}

interface QuestionRow extends Record<string, unknown> {
  id: string;
  fact_key: string;
  prompt: string;
  rule_kind: string;
  unlock_impact_minor: number;
  currency: string;
  suggested_value: string | null;
  status: string;
  created_at: string;
  updated_at: string;
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
    this.registerRuleFunctions();
    this.migrate(path);
  }

  // SQL scalar/aggregate primitives used by data-driven rule specs (see
  // docs/rules-design.md). Registered before migrate so shipped views may use them.
  private registerRuleFunctions(): void {
    // Varargs so money(minor) and money(minor, currency) both work.
    this.database.function('money', { varargs: true }, (...args: unknown[]) => moneyValue(args[0], args[1]));
    this.database.function('normalize_merchant', { deterministic: true }, (description: unknown) => normalizeMerchantValue(description));
    // Word-boundary fee/interest match (SQLite has no REGEXP; LIKE '%fee%' would
    // match "coffee"). Returns 1/0.
    this.database.function('fee_like', { deterministic: true }, (description: unknown) => (FEE_TOKEN_PATTERN.test(String(description ?? '')) ? 1 : 0));
    // Accumulator is a JSON string so the type stays a SQL value; node:sqlite's
    // types disallow a raw array accumulator.
    this.database.aggregate('median', {
      start: () => '[]',
      step: (acc: string, value: unknown) => {
        const values = JSON.parse(acc) as number[];
        if (value !== null && value !== undefined) values.push(Number(value));
        return JSON.stringify(values);
      },
      result: (acc: string) => {
        const values = JSON.parse(acc) as number[];
        if (values.length === 0) return 0;
        const sorted = values.sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
      },
    });
  }

  // Execute a rule spec's read-only query. Only SELECT/WITH is allowed, and only
  // the named params the query actually references are bound (node:sqlite rejects
  // unknown params), so callers can pass a shared superset.
  runRuleQuery(sql: string, params: Record<string, unknown>): Record<string, unknown>[] {
    if (!/^\s*(select|with)\b/i.test(sql)) {
      throw new Error('rule query must be a read-only SELECT or WITH');
    }
    const referenced = new Set((sql.match(/:[a-z_][a-z0-9_]*/gi) ?? []).map((token) => token.slice(1)));
    const bound: Record<string, SQLInputValue> = {};
    for (const key of referenced) {
      if (key in params) bound[key] = params[key] as SQLInputValue;
    }
    return this.database.prepare(sql).all(bound) as unknown as Record<string, unknown>[];
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

  private readonly ruleColumns = `kind, domain, execution_class, action_tier, scope, cadence, keywords, sql, prompt, facts, enabled, version, source, active, source_text, channel, scheduled_hour, scheduled_day, created_at, updated_at`;

  listRules(): RuleRecord[] {
    const rows = this.database.prepare(`
      SELECT ${this.ruleColumns} FROM rules
      ORDER BY active DESC, cadence, scope, kind
    `).all() as RuleRow[];
    return rows.map(mapRule);
  }

  private getRule(kind: string): RuleRecord | null {
    const row = this.database.prepare(`SELECT ${this.ruleColumns} FROM rules WHERE kind = ?`).get(kind) as RuleRow | undefined;
    return row ? mapRule(row) : null;
  }

  // Turn a rule on (by kind) with the user's schedule/channel. Definition columns
  // are untouched. Returns null when the kind has no rule row.
  adoptRule(kind: string, schedule: RuleAdoption): RuleRecord | null {
    const result = this.database.prepare(`
      UPDATE rules SET active = 1, source_text = ?, cadence = ?, channel = ?, scheduled_hour = ?, scheduled_day = ?, updated_at = ?
      WHERE kind = ?
    `).run(schedule.sourceText, schedule.cadence, schedule.channel, schedule.scheduledHour, schedule.scheduledDay, new Date().toISOString(), kind);
    return result.changes > 0 ? this.getRule(kind) : null;
  }

  toggleRule(kind: string, active: boolean): RuleRecord | null {
    const result = this.database.prepare(`
      UPDATE rules SET active = ?, updated_at = ? WHERE kind = ?
    `).run(active ? 1 : 0, new Date().toISOString(), kind);
    return result.changes > 0 ? this.getRule(kind) : null;
  }

  // Update a rule's delivery schedule (by kind), without changing its on/off state.
  updateRuleSchedule(kind: string, schedule: { cadence: string; scheduledHour: number | null; scheduledDay: number | null }): RuleRecord | null {
    const result = this.database.prepare(`
      UPDATE rules SET cadence = ?, scheduled_hour = ?, scheduled_day = ?, updated_at = ? WHERE kind = ?
    `).run(schedule.cadence, schedule.scheduledHour, schedule.scheduledDay, new Date().toISOString(), kind);
    return result.changes > 0 ? this.getRule(kind) : null;
  }

  // The definition view over the single table (used by rule inference, the facts
  // surface, and the feed sync). User-owned columns are omitted.
  listRuleSpecs(): RuleSpec[] {
    const rows = this.database.prepare(`
      SELECT kind, domain, execution_class, action_tier, scope, cadence, keywords, sql, prompt, facts, enabled, version, source
      FROM rules
      ORDER BY rowid
    `).all() as RuleSpecRow[];
    return rows.map(mapRuleSpec);
  }

  // Upsert a rule DEFINITION (builtin seed / downloaded feed). On conflict it
  // updates only the definition columns, never the user-owned adoption columns, so
  // re-seeding on startup can't wipe the user's on/off, schedule, or channel.
  upsertRuleSpec(spec: RuleSpec): void {
    const now = new Date().toISOString();
    // Every rule ships ON by default: `active` seeds to 1 on first insert. On
    // conflict it is preserved, so re-seeding never flips the user's switch back.
    // cadence is likewise preserved (see the ON CONFLICT set).
    this.database.prepare(`
      INSERT INTO rules (kind, domain, execution_class, action_tier, scope, cadence, keywords, sql, prompt, facts, enabled, version, source, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET
        domain = excluded.domain, execution_class = excluded.execution_class, action_tier = excluded.action_tier,
        scope = excluded.scope, keywords = excluded.keywords,
        sql = excluded.sql, prompt = excluded.prompt, facts = excluded.facts, enabled = excluded.enabled,
        version = excluded.version, source = excluded.source, updated_at = excluded.updated_at
    `).run(spec.kind, spec.domain, spec.executionClass, spec.actionTier, spec.scope, spec.cadence,
      spec.keywords, spec.sql, spec.prompt, JSON.stringify(spec.facts), spec.enabled ? 1 : 0, spec.version, spec.source,
      1, now, now);
  }

  // Deterministic candidate generation for the recurring classifier: one row per
  // normalized merchant + direction, merged across accounts (a merchant is
  // recurring regardless of which card paid it), with the shape features the LLM
  // reasons over. The heavy lifting (median, consecutive-gap CV) reuses the same
  // primitives as the recurring_series view.
  listRecurringCandidates(): RecurringCandidate[] {
    const rows = this.database.prepare(`
      WITH base AS (
        SELECT id, date, description, category,
          CASE WHEN amount_minor < 0 THEN 'out' ELSE 'in' END AS direction,
          ABS(amount_minor) AS amt, currency,
          normalize_merchant(description) AS merchant
        FROM transactions
        WHERE normalize_merchant(description) <> '' AND julianday('now') - julianday(date) <= 400
          AND lower(COALESCE(category, '')) NOT LIKE '%transfer%'
      ), ranked AS (
        SELECT b.*,
          ROW_NUMBER() OVER (PARTITION BY merchant, direction ORDER BY date DESC, id DESC) AS rn_desc,
          julianday(date) - julianday(
            LAG(date) OVER (PARTITION BY merchant, direction ORDER BY date ASC, id ASC)
          ) AS gap_days
        FROM base b
      ), cat AS (
        SELECT merchant, direction, category,
          ROW_NUMBER() OVER (PARTITION BY merchant, direction ORDER BY COUNT(*) DESC) AS rn
        FROM base WHERE category IS NOT NULL AND category <> ''
        GROUP BY merchant, direction, category
      ), agg AS (
        SELECT
          merchant, direction,
          MIN(currency) AS currency,
          COUNT(*) AS count,
          MIN(date) AS first_date, MAX(date) AS last_date,
          (julianday(MAX(date)) - julianday(MIN(date))) AS span_days,
          MAX(CASE WHEN rn_desc = 1 THEN description END) AS label,
          MAX(CASE WHEN rn_desc = 1 THEN amt END) AS latest_minor,
          median(CASE WHEN rn_desc > 1 THEN amt END) AS typical_minor,
          MIN(amt) AS min_minor, MAX(amt) AS max_minor,
          MAX(1.0, MIN(365.0, 365.0 / (MAX(0.5, julianday(MAX(date)) - julianday(MIN(date))) / MAX(1, COUNT(*) - 1)))) AS periods_per_year,
          sqrt(MAX(0.0, AVG(1.0 * amt * amt) - AVG(1.0 * amt) * AVG(1.0 * amt))) / NULLIF(AVG(1.0 * amt), 0) AS amount_cv,
          CASE WHEN COUNT(gap_days) >= 2
            THEN sqrt(MAX(0.0, AVG(gap_days * gap_days) - AVG(gap_days) * AVG(gap_days))) / NULLIF(AVG(gap_days), 0)
          END AS interval_cv,
          group_concat(id) AS record_ids
        FROM ranked
        GROUP BY merchant, direction
        HAVING COUNT(*) >= 2
      )
      SELECT agg.*, c.category AS category
      FROM agg LEFT JOIN (SELECT merchant, direction, category FROM cat WHERE rn = 1) c
        ON c.merchant = agg.merchant AND c.direction = agg.direction
      ORDER BY agg.count DESC, agg.latest_minor DESC
      LIMIT 500
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      merchant: String(row.merchant),
      direction: String(row.direction) as RecurringCandidate['direction'],
      label: String(row.label ?? row.merchant),
      category: row.category != null ? String(row.category) : null,
      currency: String(row.currency || 'USD'),
      count: Number(row.count),
      firstDate: String(row.first_date),
      lastDate: String(row.last_date),
      spanDays: Number(row.span_days),
      latestMinor: Number(row.latest_minor),
      typicalMinor: Number(row.typical_minor ?? row.latest_minor),
      minMinor: Number(row.min_minor),
      maxMinor: Number(row.max_minor),
      periodsPerYear: Number(row.periods_per_year),
      amountCv: row.amount_cv != null ? Number(row.amount_cv) : null,
      intervalCv: row.interval_cv != null ? Number(row.interval_cv) : null,
      recordIds: row.record_ids ? String(row.record_ids).split(',').filter(Boolean) : [],
    }));
  }

  listTransactionsByIds(ids: string[]): Transaction[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.database.prepare(`
      SELECT id, account_id, source_id, date, description, amount_minor, currency, category, pending, metadata, created_at
      FROM transactions WHERE id IN (${placeholders})
      ORDER BY date DESC, id DESC
    `).all(...ids) as TransactionRow[];
    return rows.map(mapTransaction);
  }

  listRecurringClassifications(): RecurringClassification[] {
    const rows = this.database.prepare(`
      SELECT merchant, direction, is_recurring, kind, cadence, canonical_name, confidence, signature, updated_at
      FROM recurring_classifications
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      merchant: String(row.merchant),
      direction: String(row.direction) as RecurringClassification['direction'],
      isRecurring: Number(row.is_recurring) === 1,
      kind: row.kind != null ? String(row.kind) : null,
      cadence: row.cadence != null ? String(row.cadence) : null,
      canonicalName: row.canonical_name != null ? String(row.canonical_name) : null,
      confidence: Number(row.confidence),
      signature: String(row.signature),
      updatedAt: String(row.updated_at),
    }));
  }

  upsertRecurringClassification(row: RecurringClassification): void {
    this.database.prepare(`
      INSERT INTO recurring_classifications (merchant, direction, is_recurring, kind, cadence, canonical_name, confidence, signature, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(merchant, direction) DO UPDATE SET
        is_recurring = excluded.is_recurring, kind = excluded.kind, cadence = excluded.cadence,
        canonical_name = excluded.canonical_name, confidence = excluded.confidence,
        signature = excluded.signature, updated_at = excluded.updated_at
    `).run(row.merchant, row.direction, row.isRecurring ? 1 : 0, row.kind, row.cadence, row.canonicalName,
      row.confidence, row.signature, row.updatedAt);
  }

  // Deterministic candidate generation for the merchant identifier: one row per
  // normalized merchant, with a representative raw description (the most frequent)
  // and the transaction count, for the model to reason over.
  listMerchantCandidates(): MerchantCandidate[] {
    const rows = this.database.prepare(`
      WITH base AS (
        SELECT normalize_merchant(description) AS merchant, description, category
        FROM transactions
        WHERE normalize_merchant(description) <> ''
      ), lab AS (
        SELECT merchant, description AS label, MAX(category) AS category, COUNT(*) AS n,
          ROW_NUMBER() OVER (PARTITION BY merchant ORDER BY COUNT(*) DESC, description) AS rn
        FROM base GROUP BY merchant, description
      ), agg AS (
        SELECT merchant, COUNT(*) AS count FROM base GROUP BY merchant
      )
      SELECT a.merchant AS merchant, l.label AS label, l.category AS category, a.count AS count
      FROM agg a JOIN (SELECT merchant, label, category FROM lab WHERE rn = 1) l ON l.merchant = a.merchant
      ORDER BY a.count DESC
      LIMIT 500
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      merchant: String(row.merchant),
      label: String(row.label ?? row.merchant),
      category: row.category != null ? String(row.category) : null,
      count: Number(row.count),
    }));
  }

  listMerchantIdentities(): MerchantIdentity[] {
    const rows = this.database.prepare(`
      SELECT merchant, canonical_name, canonical_slug, confidence, signature, updated_at
      FROM merchant_identities
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      merchant: String(row.merchant),
      canonicalName: String(row.canonical_name),
      canonicalSlug: String(row.canonical_slug),
      confidence: Number(row.confidence),
      signature: String(row.signature),
      updatedAt: String(row.updated_at),
    }));
  }

  upsertMerchantIdentity(row: MerchantIdentity): void {
    this.database.prepare(`
      INSERT INTO merchant_identities (merchant, canonical_name, canonical_slug, confidence, signature, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(merchant) DO UPDATE SET
        canonical_name = excluded.canonical_name, canonical_slug = excluded.canonical_slug,
        confidence = excluded.confidence, signature = excluded.signature, updated_at = excluded.updated_at
    `).run(row.merchant, row.canonicalName, row.canonicalSlug, row.confidence, row.signature, row.updatedAt);
  }

  listFindingMutes(): FindingMuteRecord[] {
    const rows = this.database.prepare(`
      SELECT id, kind, account_id, label, expires_at, created_at
      FROM finding_mutes
      ORDER BY created_at DESC
    `).all() as FindingMuteRow[];
    return rows.map(mapFindingMute);
  }

  saveFindingMute(input: Omit<FindingMuteRecord, 'id' | 'createdAt'>): FindingMuteRecord {
    const row: FindingMuteRecord = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.database.prepare(`
      INSERT INTO finding_mutes (id, kind, account_id, label, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, row.kind, row.accountId, row.label, row.expiresAt, row.createdAt);
    return row;
  }

  removeFindingMute(id: string): boolean {
    const result = this.database.prepare('DELETE FROM finding_mutes WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listFacts(): FactRecord[] {
    const rows = this.database.prepare(`
      SELECT key, value, source, confidence, refresh_after, updated_at
      FROM facts
      ORDER BY key
    `).all() as FactRow[];
    return rows.map(mapFact);
  }

  getFact(key: string): FactRecord | null {
    const row = this.database.prepare(`
      SELECT key, value, source, confidence, refresh_after, updated_at
      FROM facts WHERE key = ?
    `).get(key) as FactRow | undefined;
    return row ? mapFact(row) : null;
  }

  upsertFact(input: Omit<FactRecord, 'updatedAt'>): FactRecord {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO facts (key, value, source, confidence, refresh_after, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        source = excluded.source,
        confidence = excluded.confidence,
        refresh_after = excluded.refresh_after,
        updated_at = excluded.updated_at
    `).run(input.key, input.value, input.source, input.confidence, input.refreshAfter, now);
    return { ...input, updatedAt: now };
  }

  removeFact(key: string): boolean {
    const result = this.database.prepare('DELETE FROM facts WHERE key = ?').run(key);
    return result.changes > 0;
  }

  listQuestions(status?: QuestionRecord['status']): QuestionRecord[] {
    const rows = status
      ? this.database.prepare(`
          SELECT id, fact_key, prompt, rule_kind, unlock_impact_minor, currency, suggested_value, status, created_at, updated_at
          FROM questions WHERE status = ?
          ORDER BY unlock_impact_minor DESC, created_at DESC
        `).all(status) as QuestionRow[]
      : this.database.prepare(`
          SELECT id, fact_key, prompt, rule_kind, unlock_impact_minor, currency, suggested_value, status, created_at, updated_at
          FROM questions
          ORDER BY unlock_impact_minor DESC, created_at DESC
        `).all() as QuestionRow[];
    return rows.map(mapQuestion);
  }

  // Questions are keyed by fact_key so re-evaluation refreshes the impact estimate
  // and suggested value in place rather than piling up duplicates.
  upsertQuestion(input: Omit<QuestionRecord, 'id' | 'createdAt' | 'updatedAt'>): QuestionRecord {
    const now = new Date().toISOString();
    const existing = this.database.prepare('SELECT id, created_at FROM questions WHERE fact_key = ?').get(input.factKey) as
      | { id: string; created_at: string }
      | undefined;
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.created_at ?? now;
    this.database.prepare(`
      INSERT INTO questions (id, fact_key, prompt, rule_kind, unlock_impact_minor, currency, suggested_value, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_key) DO UPDATE SET
        prompt = excluded.prompt,
        rule_kind = excluded.rule_kind,
        unlock_impact_minor = excluded.unlock_impact_minor,
        currency = excluded.currency,
        suggested_value = excluded.suggested_value,
        updated_at = excluded.updated_at
    `).run(id, input.factKey, input.prompt, input.ruleKind, input.unlockImpactMinor, input.currency, input.suggestedValue, input.status, createdAt, now);
    return { ...input, id, createdAt, updatedAt: now };
  }

  updateQuestionStatus(id: string, status: QuestionRecord['status']): boolean {
    const result = this.database.prepare(`
      UPDATE questions SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, new Date().toISOString(), id);
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
      { version: 4, up: () => this.applyRulesEngineReset() },
      { version: 5, up: () => this.addRuleScheduledDay() },
      { version: 6, up: () => this.applyRecurringSeriesView() },
      { version: 7, up: () => this.database.exec(RULE_SPECS_SCHEMA) },
      { version: 8, up: () => this.renameNamespacedFactKeys() },
      // Recurring series now exposes amount_cv / interval_cv so recurring rules
      // can require an actual regular cadence and stable amount, not just repeat
      // visits to one merchant. Re-runs the (now DROP-and-recreate) view builder.
      { version: 9, up: () => this.applyRecurringSeriesView() },
      // Recurring detection moves from CV thresholds to an LLM classifier whose
      // verdicts live in recurring_classifications; the rules JOIN it.
      { version: 10, up: () => this.database.exec(RECURRING_CLASSIFICATIONS_SCHEMA) },
      // F1: canonical merchant identities, so rules group by vendor across
      // differing billing descriptions.
      { version: 11, up: () => this.database.exec(MERCHANT_IDENTITIES_SCHEMA) },
      // Collapse the rule_specs (definitions) + rules (instances) split into a
      // single `rules` table keyed by kind.
      { version: 12, up: () => this.applySingleRulesTable() },
      // The engine now runs on `active` alone (no separate always-on class), so
      // switch on every rule that was always-on to preserve its behaviour.
      { version: 13, up: () => this.database.exec('UPDATE rules SET active = 1 WHERE always_on = 1;') },
      // Every rule is enabled by default: switch them all on. Users can still turn
      // individual rules off afterward (preserved across re-seeding).
      { version: 14, up: () => this.database.exec('UPDATE rules SET active = 1;') },
      // Drop the now-vestigial columns: the engine runs on `active` alone, so
      // always_on and user_rule no longer carry meaning.
      { version: 15, up: () => this.dropVestigialRuleColumns() },
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

      ${RULES_ENGINE_SCHEMA}

      INSERT OR IGNORE INTO app_settings(key, value, updated_at)
      VALUES
        ('LLM_PROVIDER', 'builtin', datetime('now')),
        ('LLM_BASE_URL', '', datetime('now')),
        ('LLM_MODEL', 'qwen2.5-3b-instruct', datetime('now')),
        ('LLM_CHAT_MODEL', 'qwen2.5-3b-instruct', datetime('now'));
    `);
  }

  // Migration v4 resets the rules subsystem to the engine schema. Old rule and
  // mute rows are intentionally dropped; there is no external contract to
  // preserve, and the backup-before-migrate step protects everything else. Fresh
  // installs get the same tables from applyInitialSchema, so this is a no-op there.
  private applyRulesEngineReset(): void {
    this.database.exec(`
      DROP TABLE IF EXISTS alert_rules;
      DROP TABLE IF EXISTS alert_mutes;
      ${RULES_ENGINE_SCHEMA}
    `);
  }

  // Migration v15: the engine runs on `active` alone, so always_on and user_rule
  // are dead weight. Drop them (recreating the run index without always_on first,
  // since a column in an index can't be dropped).
  private dropVestigialRuleColumns(): void {
    this.database.exec(`
      DROP INDEX IF EXISTS rules_run_idx;
      ALTER TABLE rules DROP COLUMN always_on;
      ALTER TABLE rules DROP COLUMN user_rule;
      CREATE INDEX IF NOT EXISTS rules_run_idx ON rules(enabled, active);
    `);
  }

  // Migration v12: fold the two-table model (rule_specs definitions + rules
  // instances) into one `rules` table keyed by kind. Every definition becomes a
  // row; a matching instance (if any) sets user_rule=1, active from its enabled
  // flag, and carries its schedule/channel. On a fresh install rule_specs is
  // still empty here (the service seeds builtins after migration), so this yields
  // an empty merged table that seeding then fills.
  private applySingleRulesTable(): void {
    const now = new Date().toISOString();
    this.database.exec(`
      ALTER TABLE rules RENAME TO rules_legacy;
      ${MERGED_RULES_SCHEMA}
      INSERT INTO rules (
        kind, domain, execution_class, action_tier, scope, cadence, always_on, keywords, sql, prompt, facts,
        enabled, version, source, user_rule, active, source_text, channel, scheduled_hour, scheduled_day, created_at, updated_at
      )
      SELECT
        s.kind, s.domain, s.execution_class, s.action_tier, s.scope, s.cadence, s.always_on, s.keywords, s.sql, s.prompt, s.facts,
        s.enabled, s.version, s.source,
        CASE WHEN o.kind IS NOT NULL THEN 1 ELSE 0 END,
        CASE WHEN o.enabled = 1 THEN 1 ELSE 0 END,
        COALESCE(o.source_text, ''),
        COALESCE(o.channel, 'auto'),
        o.scheduled_hour, o.scheduled_day,
        COALESCE(o.created_at, '${now}'), '${now}'
      FROM rule_specs s
      LEFT JOIN (
        SELECT kind, enabled, channel, scheduled_hour, scheduled_day, source_text, created_at,
               ROW_NUMBER() OVER (PARTITION BY kind ORDER BY updated_at DESC) AS rn
        FROM rules_legacy
      ) o ON o.kind = s.kind AND o.rn = 1;
      DROP TABLE rules_legacy;
      DROP TABLE rule_specs;
    `);
  }

  // Migration v5 adds the schedule day column for weekly/monthly rules. Guarded
  // because fresh installs already get the column from the v1/v4 baseline, so the
  // ALTER only runs on databases that applied v4 before the column existed.
  // Shared recurring-charge primitive used by subscription/bill rule specs, so a
  // downloaded rule can just SELECT FROM recurring_series. Groups the last ~400
  // days of transactions by normalized merchant and direction, and derives count,
  // span, latest/typical amount, and cadence. Uses the normalize_merchant and
  // median UDFs registered on the connection.
  private applyRecurringSeriesView(): void {
    // DROP first so an existing database picks up column/definition changes: a
    // bare CREATE VIEW IF NOT EXISTS would keep the stale view. This makes the
    // method safe to re-run from a later migration when the shape changes.
    this.database.exec(`
      DROP VIEW IF EXISTS recurring_series;
      CREATE VIEW recurring_series AS
      WITH base AS (
        SELECT account_id, id, date, description,
          CASE WHEN amount_minor < 0 THEN 'out' ELSE 'in' END AS direction,
          ABS(amount_minor) AS amt, currency,
          normalize_merchant(description) AS merchant
        FROM transactions
        WHERE normalize_merchant(description) <> '' AND julianday('now') - julianday(date) <= 400
      ), ranked AS (
        SELECT b.*,
          ROW_NUMBER() OVER (PARTITION BY account_id, merchant, direction ORDER BY date DESC, id DESC) AS rn_desc,
          julianday(date) - julianday(
            LAG(date) OVER (PARTITION BY account_id, merchant, direction ORDER BY date ASC, id ASC)
          ) AS gap_days
        FROM base b
      )
      SELECT
        account_id, merchant, direction,
        MIN(currency) AS currency,
        COUNT(*) AS count,
        (julianday(MAX(date)) - julianday(MIN(date))) AS span_days,
        MAX(CASE WHEN rn_desc = 1 THEN amt END) AS latest_minor,
        MAX(CASE WHEN rn_desc = 1 THEN description END) AS label,
        MAX(CASE WHEN rn_desc = 1 THEN id END) AS latest_id,
        median(CASE WHEN rn_desc > 1 THEN amt END) AS typical_minor,
        MIN(date) AS first_date,
        MAX(date) AS last_date,
        MAX(1.0, MIN(52.0, 365.0 / ((julianday(MAX(date)) - julianday(MIN(date))) / (COUNT(*) - 1)))) AS periods_per_year,
        -- Amount consistency: population coefficient of variation of the charge
        -- amounts. Near 0 for a fixed-price subscription; large for variable
        -- spend at one merchant (ride-hailing, shopping) where every charge is a
        -- different size. This is what separates a subscription from a merchant
        -- you simply buy from repeatedly.
        sqrt(MAX(0.0, AVG(1.0 * amt * amt) - AVG(1.0 * amt) * AVG(1.0 * amt))) / NULLIF(AVG(1.0 * amt), 0) AS amount_cv,
        -- Cadence regularity: coefficient of variation of the gaps between
        -- consecutive charges. Low when charges land on a schedule (a monthly
        -- bill), high when they cluster and gap at random. NULL until there are
        -- at least two gaps (three charges) to compare — with fewer, cadence
        -- cannot be judged and callers fall back to amount consistency.
        CASE WHEN COUNT(gap_days) >= 2
          THEN sqrt(MAX(0.0, AVG(gap_days * gap_days) - AVG(gap_days) * AVG(gap_days))) / NULLIF(AVG(gap_days), 0)
        END AS interval_cv,
        group_concat(id) AS record_ids
      FROM ranked
      GROUP BY account_id, merchant, direction;
    `);
  }

  private addRuleScheduledDay(): void {
    const columns = this.database.prepare('PRAGMA table_info(rules)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'scheduled_day')) {
      this.database.exec('ALTER TABLE rules ADD COLUMN scheduled_day INTEGER');
    }
  }

  // Adopt namespaced fact keys (income.* / retirement.*) so rules share facts by a
  // stable, collision-safe key. Renames the pre-namespace employer-match facts in
  // place; stale questions keyed by the old names are cleared, since refreshQuestions
  // re-derives them from the updated specs on the next read.
  private renameNamespacedFactKeys(): void {
    const renames: [string, string][] = [
      ['annual_income', 'income.gross_annual'],
      ['retirement_contribution_pct', 'retirement.contribution_pct'],
      ['employer_match_pct', 'retirement.employer_match_pct'],
    ];
    for (const [oldKey, newKey] of renames) {
      this.database.prepare('UPDATE facts SET key = ? WHERE key = ?').run(newKey, oldKey);
      this.database.prepare('DELETE FROM questions WHERE fact_key = ?').run(oldKey);
    }
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

function mapRule(row: RuleRow): RuleRecord {
  let facts: RuleRecord['facts'] = [];
  try {
    const parsed: unknown = JSON.parse(row.facts);
    if (Array.isArray(parsed)) facts = parsed as RuleRecord['facts'];
  } catch { facts = []; }
  return {
    kind: row.kind,
    domain: row.domain as RuleRecord['domain'],
    executionClass: row.execution_class as RuleRecord['executionClass'],
    actionTier: row.action_tier as RuleRecord['actionTier'],
    scope: row.scope,
    cadence: row.cadence,
    keywords: row.keywords,
    sql: row.sql,
    prompt: row.prompt,
    facts,
    enabled: row.enabled === 1,
    version: Number(row.version),
    source: row.source,
    active: row.active === 1,
    sourceText: row.source_text,
    channel: row.channel,
    scheduledHour: typeof row.scheduled_hour === 'number' ? row.scheduled_hour : null,
    scheduledDay: typeof row.scheduled_day === 'number' ? row.scheduled_day : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuleSpec(row: RuleSpecRow): RuleSpec {
  let facts: RuleSpec['facts'] = [];
  try {
    const parsed: unknown = JSON.parse(row.facts);
    if (Array.isArray(parsed)) facts = parsed as RuleSpec['facts'];
  } catch { facts = []; }
  return {
    kind: row.kind,
    domain: row.domain as RuleSpec['domain'],
    executionClass: row.execution_class as RuleSpec['executionClass'],
    actionTier: row.action_tier as RuleSpec['actionTier'],
    scope: row.scope,
    cadence: row.cadence,
    keywords: row.keywords,
    sql: row.sql,
    prompt: row.prompt,
    facts,
    enabled: row.enabled === 1,
    version: Number(row.version),
    source: row.source,
  };
}

function mapFindingMute(row: FindingMuteRow): FindingMuteRecord {
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.account_id,
    label: row.label,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapFact(row: FactRow): FactRecord {
  return {
    key: row.key,
    value: row.value,
    source: row.source as FactRecord['source'],
    confidence: row.confidence,
    refreshAfter: row.refresh_after,
    updatedAt: row.updated_at,
  };
}

function mapQuestion(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    factKey: row.fact_key,
    prompt: row.prompt,
    ruleKind: row.rule_kind,
    unlockImpactMinor: Number(row.unlock_impact_minor),
    currency: row.currency,
    suggestedValue: row.suggested_value,
    status: row.status as QuestionRecord['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
