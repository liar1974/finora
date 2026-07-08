// Rules engine. See docs/rules-design.md for the design of record.
//
// A rule is normalized metadata; this module is the interpreter. Detection is a
// registry of evaluators, each of which declares the capability its condition
// requires (D / L / L+), the domain it belongs to, and any user facts it depends
// on. Every evaluator emits the same Finding contract, so ranking, delivery, and
// actions never need to know which evaluator produced a finding.
//
// Findings are computed on read and never persisted. Money is signed integer
// minor units; dollarImpactMinor is normalized to a twelve-month horizon so
// findings are comparable across rules.

import type {
  FactRecord,
  Finding,
  FindingEvidence,
  RuleActionTier,
  RuleDomain,
  RuleExecutionClass,
  RuleRecord,
  RuleSpec,
} from '../domain/models.js';

// ── Reference data ───────────────────────────────────────────────────────────
// Slow-changing world data ships with the engine and is versioned with it; no
// live external call. Update the bundle to change these values.
const REFERENCE_TABLES = {
  version: '2026.1',
  // Benchmark APRs used to price idle cash against where it could sit instead.
  highYieldSavingsApr: 0.048,
  checkingApr: 0.0001,
};

// ── Ranking ──────────────────────────────────────────────────────────────────
// score = |dollarImpactMinor| * confidence * urgency / effort. Below the suppress
// floor a finding is not surfaced at all, unless it is an explicit high-severity
// safety finding (which carries no dollar value by design).
const SUPPRESS_SCORE = 2_000; // ~ $20/yr weighted
const HIGH_SCORE = 30_000; // ~ $300/yr weighted
const MEDIUM_SCORE = 8_000; // ~ $80/yr weighted

const TIER_RANK: Record<RuleActionTier, number> = {
  observer: 0,
  advisor: 1,
  guardian: 2,
  navigator: 3,
};

function deriveSeverity(score: number): Finding['severity'] {
  if (score >= HIGH_SCORE) return 'high';
  if (score >= MEDIUM_SCORE) return 'medium';
  return 'low';
}

// Confidence caps the action tier: a finding built on low-confidence input (for
// example a self-entered fact) may not run above Advisor. Autonomous action needs
// both a high-confidence finding and an explicit grant.
function capTier(tier: RuleActionTier, confidence: number): RuleActionTier {
  if (confidence < 0.6 && TIER_RANK[tier] > TIER_RANK.advisor) return 'advisor';
  return tier;
}

// ── Evaluator contract ───────────────────────────────────────────────────────

// SQL specs read account data straight from the DB via runQuery, so the engine
// itself only needs the facts (to gate fact-dependent rules) and the clock.
export interface EvaluationData {
  facts: Map<string, FactRecord>;
  nowMs: number;
}

// A partial finding produced by an evaluator. The engine finalizes it into a
// Finding by computing id, score, severity, and the confidence-capped action.
interface Draft {
  key: string; // stable per-subject suffix for id and dedupe
  title: string;
  detail: string;
  value: string;
  confidence: number;
  evidence: FindingEvidence;
  dollarImpactMinor?: number;
  currency?: string;
  urgency?: number;
  effort?: number;
  severity?: Finding['severity']; // overrides the score-derived severity
  actionLabel?: string;
  accountId?: string;
  createdAt: string;
}

interface FactNeed {
  key: string;
  prompt: string;
  unlockImpactMinor: number; // estimated dollars the answer would unlock, for ranking questions
  currency?: string;
  expects?: 'currency' | 'percent' | 'number' | 'date' | 'text'; // value shape, for input normalization
}

// The built-in rule definitions, authored in code and seeded into rule_specs as
// data (see docs/rules-design.md). keywords is a RegExp for readability; it is
// stored as a source string. Every rule carries a SQL query that selects the
// finding-draft columns.
interface Evaluator {
  kind: string;
  domain: RuleDomain;
  executionClass: RuleExecutionClass;
  defaultTier: RuleActionTier;
  scope: string;
  keywords: RegExp; // for natural-language rule inference
  alwaysOn?: boolean; // runs even with no stored rule of this kind
  facts?: FactNeed[];
  sql: string;
}

// Runs a rule spec's read-only query with the bound param superset. Supplied by
// the caller (the repository), keeping SQLite behind the port.
export type RuleQueryRunner = (sql: string, params: Record<string, unknown>) => Record<string, unknown>[];

// Map a SQL result row (snake_case finding columns) to a Draft.
function rowToDraft(row: Record<string, unknown>): Draft {
  const records = row.evidence_records ? String(row.evidence_records).split(',').filter(Boolean) : [];
  const draft: Draft = {
    key: String(row.key),
    title: String(row.title),
    detail: String(row.detail),
    value: String(row.value),
    confidence: Number(row.confidence),
    evidence: { summary: String(row.evidence_summary ?? ''), records },
    createdAt: String(row.created_at),
  };
  if (row.dollar_impact_minor != null) draft.dollarImpactMinor = Number(row.dollar_impact_minor);
  if (row.currency != null) draft.currency = String(row.currency);
  if (row.urgency != null) draft.urgency = Number(row.urgency);
  if (row.effort != null) draft.effort = Number(row.effort);
  if (row.severity != null) draft.severity = String(row.severity) as 'high' | 'medium' | 'low';
  if (row.action_label != null) draft.actionLabel = String(row.action_label);
  if (row.account_id != null) draft.accountId = String(row.account_id);
  return draft;
}

export interface QuestionDraft {
  factKey: string;
  prompt: string;
  ruleKind: string;
  unlockImpactMinor: number;
  currency: string;
  suggestedValue: string | null;
}

export interface EngineResult {
  findings: Finding[];
  questions: QuestionDraft[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────












// ── Evaluators ───────────────────────────────────────────────────────────────

const idleCash: Evaluator = {
  kind: 'idle-cash',
  domain: 'cash-flow',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /idle|cash|savings|high[- ]?yield|hysa|现金|闲置/,
  sql: `
    WITH latest AS (
      SELECT b.*, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of_date DESC, id DESC) AS rn FROM account_balances b
    ), c AS (
      SELECT lb.account_id, lb.currency, lb.current_minor, lb.created_at,
             COALESCE(lb.available_minor, lb.current_minor) AS cash,
             CAST(ROUND(COALESCE(lb.available_minor, lb.current_minor) * (:hysa_apr - :checking_apr)) AS INT) AS impact,
             a.name AS account_name
      FROM latest lb JOIN accounts a ON a.id = lb.account_id
      WHERE lb.rn = 1 AND a.domain <> 'brokerage' AND a.domain <> 'credit'
        AND lower(a.type || ' ' || a.name) NOT LIKE '%credit%'
        AND lower(a.type || ' ' || a.name) NOT LIKE '%card%'
        AND lb.current_minor > 0
        AND 1.0 * COALESCE(lb.available_minor, lb.current_minor) / lb.current_minor >= 0.3
    )
    SELECT
      account_id AS key,
      account_name || ' has idle cash' AS title,
      money(cash, currency) || ' sitting at roughly ' || printf('%.2f', :checking_apr * 100) || '% could earn about ' || money(impact, currency) || '/yr at ' || printf('%.1f', :hysa_apr * 100) || '%.' AS detail,
      money(impact, currency) AS value,
      impact AS dollar_impact_minor,
      currency AS currency,
      0.8 AS confidence,
      3 AS effort,
      'Available cash ' || money(cash, currency) || ' priced against the savings benchmark.' AS evidence_summary,
      account_id AS evidence_records,
      'Move to a high-yield savings account' AS action_label,
      account_id AS account_id,
      created_at AS created_at
    FROM c
  `,
};

const idleBrokerageCash: Evaluator = {
  kind: 'idle-brokerage-cash',
  domain: 'investments',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'brokerage',
  keywords: /cash drag|brokerage cash|sweep|uninvested|现金拖累/,
  alwaysOn: true,
  sql: `
    WITH latest AS (
      SELECT b.*, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of_date DESC, id DESC) AS rn FROM account_balances b
    )
    SELECT
      lb.account_id AS key,
      a.name || ' cash drag' AS title,
      money(lb.cash_minor, lb.currency) || ' uninvested of ' || money(lb.current_minor, lb.currency) || '; about ' || money(CAST(ROUND(lb.cash_minor * :hysa_apr) AS INT), lb.currency) || '/yr in a swept money-market rate.' AS detail,
      CAST(ROUND(100.0 * lb.cash_minor / lb.current_minor) AS INT) || '%' AS value,
      CAST(ROUND(lb.cash_minor * :hysa_apr) AS INT) AS dollar_impact_minor,
      lb.currency AS currency,
      0.7 AS confidence,
      2 AS effort,
      'Uninvested cash ' || money(lb.cash_minor, lb.currency) || ' of ' || money(lb.current_minor, lb.currency) || '.' AS evidence_summary,
      lb.account_id AS evidence_records,
      'Invest or sweep the idle cash' AS action_label,
      lb.account_id AS account_id,
      lb.created_at AS created_at
    FROM latest lb JOIN accounts a ON a.id = lb.account_id
    WHERE lb.rn = 1 AND a.domain = 'brokerage' AND lb.current_minor > 0
      AND lb.cash_minor IS NOT NULL AND 1.0 * lb.cash_minor / lb.current_minor >= 0.3
  `,
};

const largeTransaction: Evaluator = {
  kind: 'large-transaction',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'banking',
  keywords: /large|big|unusual|charge|transaction|spend|消费|大额/,
  sql: `
    SELECT
      t.id AS key,
      'Large transaction: ' || t.description AS title,
      COALESCE(a.name, 'Account') || ' · ' || t.date || ' · ' || money(t.amount_minor, t.currency) AS detail,
      money(t.amount_minor, t.currency) AS value,
      ABS(t.amount_minor) AS dollar_impact_minor,
      t.currency AS currency,
      0.5 AS confidence,
      2 AS effort,
      'Outflow of ' || money(ABS(t.amount_minor), t.currency) || ' on ' || t.date || '.' AS evidence_summary,
      t.id AS evidence_records,
      t.account_id AS account_id,
      t.created_at AS created_at
    FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
    WHERE julianday(:now_iso) - julianday(t.date) <= 30 AND t.amount_minor < 0 AND ABS(t.amount_minor) >= 50000
    ORDER BY ABS(t.amount_minor) DESC
    LIMIT 20
  `,
};

const duplicateCharge: Evaluator = {
  kind: 'duplicate-charge',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /duplicate|double|charged twice|重复|重复扣费/,
  sql: `
    WITH d AS (
      SELECT t1.id AS id1, t2.id AS id2, t1.account_id, t1.amount_minor, t1.currency, t1.description,
             t1.date AS d1, t2.date AS d2, ABS(julianday(t1.date) - julianday(t2.date)) AS gap
      FROM transactions t1 JOIN transactions t2
        ON t1.account_id = t2.account_id AND t1.amount_minor = t2.amount_minor
        AND normalize_merchant(t1.description) = normalize_merchant(t2.description)
        AND t1.id < t2.id
      WHERE t1.amount_minor < 0 AND julianday(:now_iso) - julianday(t1.date) <= 30
        AND ABS(julianday(t1.date) - julianday(t2.date)) <= 3
    )
    SELECT
      id1 || ':' || id2 AS key,
      'Possible duplicate charge: ' || description AS title,
      money(amount_minor, currency) || ' on ' || d1 || ' and ' || d2 || '.' AS detail,
      money(ABS(amount_minor), currency) AS value,
      ABS(amount_minor) AS dollar_impact_minor,
      currency,
      0.55 AS confidence,
      3 AS effort,
      'Two charges of ' || money(ABS(amount_minor), currency) || ' within ' || CAST(ROUND(gap) AS INT) || ' day(s).' AS evidence_summary,
      id1 || ',' || id2 AS evidence_records,
      'Review and dispute the duplicate' AS action_label,
      account_id AS account_id,
      :now_iso AS created_at
    FROM d
    LIMIT 20
  `,
};

const portfolioConcentration: Evaluator = {
  kind: 'portfolio-concentration',
  domain: 'investments',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'brokerage',
  keywords: /concentration|portfolio|holding|allocation|持仓|集中/,
  alwaysOn: true,
  sql: `
    WITH latest_h AS (
      SELECT h.*, ROW_NUMBER() OVER (
        PARTITION BY account_id, COALESCE(security_id, symbol, name, security_type, ''), currency
        ORDER BY as_of_date DESC, created_at DESC, id DESC) AS rn
      FROM brokerage_holdings h
    ), h AS (SELECT * FROM latest_h WHERE rn = 1),
    tot AS (SELECT SUM(value_minor) AS total FROM h),
    top AS (SELECT * FROM h ORDER BY value_minor DESC LIMIT 1)
    SELECT
      top.id AS key,
      COALESCE(top.symbol, top.name, 'Top holding') || ' concentration' AS title,
      COALESCE(a.name, 'Brokerage') || ' holds ' || money(top.value_minor, top.currency) || ' of ' || money(tot.total, top.currency) || ' tracked holdings.' AS detail,
      CAST(ROUND(100.0 * top.value_minor / tot.total) AS INT) || '%' AS value,
      0.7 AS confidence,
      CASE WHEN 1.0 * top.value_minor / tot.total >= 0.4 THEN 'high' ELSE 'medium' END AS severity,
      'Largest holding is ' || CAST(ROUND(100.0 * top.value_minor / tot.total) AS INT) || '% of tracked value.' AS evidence_summary,
      top.id AS evidence_records,
      top.account_id AS account_id,
      top.created_at AS created_at
    FROM top CROSS JOIN tot LEFT JOIN accounts a ON a.id = top.account_id
    WHERE tot.total > 0 AND 1.0 * top.value_minor / tot.total >= 0.2
  `,
};

const creditUtilization: Evaluator = {
  kind: 'credit-utilization',
  domain: 'credit',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'credit',
  keywords: /utilization|credit limit|信用利用率|利用率/,
  sql: `
    WITH latest AS (
      SELECT b.*, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of_date DESC, id DESC) AS rn
      FROM account_balances b
    )
    SELECT
      lb.account_id AS key,
      a.name || ' utilization is elevated' AS title,
      money(lb.current_minor, lb.currency) || ' balance on ' || money(lb.limit_minor, lb.currency) || ' limit.' AS detail,
      CAST(ROUND(100.0 * lb.current_minor / lb.limit_minor) AS INT) || '%' AS value,
      0.9 AS confidence,
      CASE WHEN 1.0 * lb.current_minor / lb.limit_minor >= 0.7 THEN 'high' ELSE 'medium' END AS severity,
      CASE WHEN 1.0 * lb.current_minor / lb.limit_minor >= 0.7 THEN 1.5 ELSE 1 END AS urgency,
      'Utilization ' || CAST(ROUND(100.0 * lb.current_minor / lb.limit_minor) AS INT) || '% before statement close.' AS evidence_summary,
      lb.account_id AS evidence_records,
      'Pay down before the statement closes' AS action_label,
      lb.account_id AS account_id,
      lb.created_at AS created_at
    FROM latest lb JOIN accounts a ON a.id = lb.account_id
    WHERE lb.rn = 1
      AND (a.domain = 'credit' OR lower(a.type || ' ' || a.name) LIKE '%credit%' OR lower(a.type || ' ' || a.name) LIKE '%card%')
      AND lb.limit_minor IS NOT NULL AND lb.limit_minor > 0 AND lb.current_minor > 0
      AND 1.0 * lb.current_minor / lb.limit_minor >= 0.3
  `,
};

const connectionHealth: Evaluator = {
  kind: 'connection-health',
  domain: 'connections',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'all',
  keywords: /connection|sync|token|cursor|plaid|snaptrade|link/,
  alwaysOn: true,
  sql: `
    SELECT
      provider || ':' || external_id AS key,
      COALESCE(institution, provider) || ' connection needs review' AS title,
      'Status ' || status
        || '; token saved: ' || (CASE WHEN access_token IS NOT NULL THEN 'yes' ELSE 'no' END)
        || '; cursor saved: ' || (CASE WHEN cursor IS NOT NULL THEN 'yes' ELSE 'no' END) || '.' AS detail,
      'Review' AS value,
      0.95 AS confidence,
      'high' AS severity,
      'Provider connection is not fully healthy.' AS evidence_summary,
      provider || ':' || external_id AS evidence_records,
      updated_at AS created_at
    FROM provider_connections
    WHERE status <> 'active' OR access_token IS NULL OR (provider = 'plaid' AND cursor IS NULL)
  `,
};

// Fact-gated: demonstrates the facts-and-questions layer. Its external data — the
// user's contribution rate, employer match, and income — is knowable by the user,
// so it is asked rather than integrated. Missing facts become ranked questions.
const employerMatch: Evaluator = {
  kind: 'employer-match',
  domain: 'cash-flow',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'all',
  keywords: /401k|401\(k\)|employer match|retirement match|matching|雇主匹配/,
  alwaysOn: true,
  // Fact keys are namespaced by subject (income.* / retirement.*), not by rule
  // domain, so one answer serves every rule that references the key and downloaded
  // rules can't collide. income.gross_annual is an income fact this rule borrows.
  facts: [
    { key: 'income.gross_annual', prompt: 'What is your gross annual salary?', unlockImpactMinor: 240_000, expects: 'currency' },
    { key: 'retirement.contribution_pct', prompt: 'What percent of salary do you contribute to your 401(k)?', unlockImpactMinor: 240_000, expects: 'percent' },
    { key: 'retirement.employer_match_pct', prompt: 'Up to what percent of salary does your employer match?', unlockImpactMinor: 240_000, expects: 'percent' },
  ],
  sql: `
    WITH f AS (
      SELECT
        MAX(CASE WHEN key = 'income.gross_annual' THEN CAST(REPLACE(REPLACE(value, '$', ''), ',', '') AS REAL) END) AS income,
        MAX(CASE WHEN key = 'retirement.contribution_pct' THEN CAST(value AS REAL) END) AS contrib_raw,
        MAX(CASE WHEN key = 'retirement.employer_match_pct' THEN CAST(value AS REAL) END) AS match_raw,
        MIN(confidence) AS conf
      FROM facts WHERE key IN ('income.gross_annual', 'retirement.contribution_pct', 'retirement.employer_match_pct')
    ),
    n AS (
      SELECT income, conf,
        CASE WHEN contrib_raw > 1 THEN contrib_raw / 100.0 ELSE contrib_raw END AS contrib,
        CASE WHEN match_raw > 1 THEN match_raw / 100.0 ELSE match_raw END AS matchp
      FROM f
    )
    SELECT
      'employer-match' AS key,
      'You are leaving employer 401(k) match on the table' AS title,
      'Contributing ' || printf('%.1f', contrib * 100) || '% against a ' || printf('%.1f', matchp * 100) || '% match forgoes about ' || money(CAST(ROUND(income * 100 * (matchp - contrib)) AS INT)) || '/yr in free money.' AS detail,
      money(CAST(ROUND(income * 100 * (matchp - contrib)) AS INT)) || '/yr' AS value,
      CAST(ROUND(income * 100 * (matchp - contrib)) AS INT) AS dollar_impact_minor,
      COALESCE(conf, 0.7) AS confidence,
      3 AS effort,
      'Match ' || printf('%.1f', matchp * 100) || '% minus contribution ' || printf('%.1f', contrib * 100) || '% on ' || money(CAST(income * 100 AS INT)) || ' income.' AS evidence_summary,
      'fact:retirement.employer_match_pct,fact:retirement.contribution_pct,fact:income.gross_annual' AS evidence_records,
      'Raise contribution to at least the full match' AS action_label,
      :now_iso AS created_at
    FROM n
    WHERE income IS NOT NULL AND contrib IS NOT NULL AND matchp IS NOT NULL AND (matchp - contrib) > 0
  `,
};

// Cash flow: a checking/savings balance that is low or overdrawn. Risk-based, so
// it carries no dollar value but an explicit severity so it always surfaces.
const lowBalance: Evaluator = {
  kind: 'low-balance',
  domain: 'cash-flow',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'banking',
  keywords: /low balance|overdraft|overdrawn|negative balance|低余额|余额不足/,
  alwaysOn: true,
  sql: `
    WITH latest AS (
      SELECT b.*, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of_date DESC, id DESC) AS rn
      FROM account_balances b
    )
    SELECT
      lb.account_id AS key,
      a.name || (CASE WHEN lb.current_minor < 0 THEN ' is overdrawn' ELSE ' balance is low' END) AS title,
      'Current balance ' || money(lb.current_minor, lb.currency) || '.' AS detail,
      money(lb.current_minor, lb.currency) AS value,
      0.95 AS confidence,
      CASE WHEN lb.current_minor < 0 THEN 'high' ELSE 'medium' END AS severity,
      CASE WHEN lb.current_minor < 0 THEN 2 ELSE 1 END AS urgency,
      'Balance ' || money(lb.current_minor, lb.currency) || ' on a spending account.' AS evidence_summary,
      lb.account_id AS evidence_records,
      CASE WHEN lb.current_minor < 0 THEN 'Transfer funds to avoid overdraft fees' ELSE NULL END AS action_label,
      lb.account_id AS account_id,
      :now_iso AS created_at
    FROM latest lb JOIN accounts a ON a.id = lb.account_id
    WHERE lb.rn = 1
      AND a.domain <> 'brokerage' AND a.domain <> 'credit'
      AND lower(a.type || ' ' || a.name) NOT LIKE '%credit%'
      AND lower(a.type || ' ' || a.name) NOT LIKE '%card%'
      AND lb.current_minor < 10000
  `,
};

// Spending: money lost to bank/card fees and interest. One aggregate finding over
// the last 90 days, annualized. Stream-only via description matching.
const feesAndInterest: Evaluator = {
  kind: 'fees-and-interest',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /fee|fees|interest charge|finance charge|overdraft|费用|利息/,
  alwaysOn: true,
  sql: `
    WITH fees AS (
      SELECT id, ABS(amount_minor) AS amt, currency
      FROM transactions
      WHERE amount_minor < 0 AND julianday(:now_iso) - julianday(date) <= 90
        AND fee_like(description) = 1
    )
    SELECT
      'fees-90d' AS key,
      'You paid ' || money(SUM(amt), MIN(currency)) || ' in fees & interest' AS title,
      COUNT(*) || ' fee or interest charge(s) in the last 90 days — about ' || money(CAST(ROUND(SUM(amt) * 365.0 / 90) AS INT), MIN(currency)) || '/yr.' AS detail,
      money(CAST(ROUND(SUM(amt) * 365.0 / 90) AS INT), MIN(currency)) AS value,
      CAST(ROUND(SUM(amt) * 365.0 / 90) AS INT) AS dollar_impact_minor,
      MIN(currency) AS currency,
      0.7 AS confidence,
      3 AS effort,
      'Sum of ' || COUNT(*) || ' fee/interest charges over 90 days.' AS evidence_summary,
      (SELECT group_concat(id) FROM (SELECT id FROM fees LIMIT 10)) AS evidence_records,
      'Review and dispute avoidable fees' AS action_label,
      :now_iso AS created_at
    FROM fees
    HAVING COUNT(*) > 0
  `,
};

// Spending: a recurring charge whose latest amount rose against its own history —
// the silent price hike. Impact is the annualized increase.
const subscriptionPriceIncrease: Evaluator = {
  kind: 'subscription-price-increase',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /price increase|went up|price hike|raised|涨价|加价/,
  alwaysOn: true,
  sql: `
    SELECT
      rs.merchant AS key,
      COALESCE(rc.canonical_name, rs.label) || ' charge went up' AS title,
      'Now ' || money(rs.latest_minor, rs.currency) || ' vs a usual ' || money(rs.typical_minor, rs.currency) || ' — about ' || money(CAST(ROUND((rs.latest_minor - rs.typical_minor) * rs.periods_per_year) AS INT), rs.currency) || '/yr more.' AS detail,
      money(CAST(ROUND((rs.latest_minor - rs.typical_minor) * rs.periods_per_year) AS INT), rs.currency) AS value,
      CAST(ROUND((rs.latest_minor - rs.typical_minor) * rs.periods_per_year) AS INT) AS dollar_impact_minor,
      rs.currency,
      0.6 AS confidence,
      2 AS effort,
      'Latest ' || money(rs.latest_minor, rs.currency) || ' exceeds prior median ' || money(rs.typical_minor, rs.currency) || ' across ' || rs.count || ' charges.' AS evidence_summary,
      rs.record_ids AS evidence_records,
      'Review or renegotiate the increase' AS action_label,
      rs.account_id AS account_id,
      rs.last_date AS created_at
    FROM recurring_series rs
    JOIN recurring_classifications rc ON rc.merchant = rs.merchant AND rc.direction = rs.direction
    WHERE rs.direction = 'out' AND rc.is_recurring = 1 AND fee_like(rs.label) = 0
      AND rs.typical_minor > 0 AND rs.latest_minor > rs.typical_minor * 1.1
      AND ROUND((rs.latest_minor - rs.typical_minor) * rs.periods_per_year) >= 1200
  `,
};

// Spending: the running annual cost of each detected subscription, so ghost or
// forgotten memberships are visible. Opt-in (not always-on) to stay quiet.
const recurringSubscriptions: Evaluator = {
  kind: 'recurring-subscriptions',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /subscription|recurring|membership|订阅|会员/,
  sql: `
    SELECT
      rs.merchant AS key,
      'Subscription: ' || COALESCE(rc.canonical_name, rs.label) AS title,
      'About ' || money(CAST(ROUND(rs.latest_minor * rs.periods_per_year) AS INT), rs.currency) || '/yr — ' || rs.count || ' charges of ~' || money(rs.latest_minor, rs.currency) || '.' AS detail,
      money(CAST(ROUND(rs.latest_minor * rs.periods_per_year) AS INT), rs.currency) AS value,
      CAST(ROUND(rs.latest_minor * rs.periods_per_year) AS INT) AS dollar_impact_minor,
      rs.currency,
      COALESCE(rc.confidence, 0.5) AS confidence,
      1 AS effort,
      rs.count || ' recurring charges of ~' || money(rs.latest_minor, rs.currency) || '.' AS evidence_summary,
      rs.record_ids AS evidence_records,
      'Cancel if you no longer use it' AS action_label,
      rs.account_id AS account_id,
      rs.last_date AS created_at
    FROM recurring_series rs
    JOIN recurring_classifications rc ON rc.merchant = rs.merchant AND rc.direction = rs.direction
    WHERE rs.direction = 'out' AND rc.is_recurring = 1 AND rc.kind IN ('subscription', 'membership')
      AND fee_like(rs.label) = 0
      AND ROUND(rs.latest_minor * rs.periods_per_year) >= 6000
    ORDER BY rs.latest_minor * rs.periods_per_year DESC
    LIMIT 15
  `,
};

// Spending: a discretionary category whose last-30-day spend is materially above
// its prior 3-month average — lifestyle inflation. Uses Plaid categories.
const spendingCategorySpike: Evaluator = {
  kind: 'spending-category-spike',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'banking',
  keywords: /spending spike|category spend|lifestyle|overspend|超支|消费激增/,
  sql: `
    WITH cur AS (
      SELECT category, SUM(ABS(amount_minor)) AS amt FROM transactions
      WHERE amount_minor < 0 AND category IS NOT NULL AND category <> ''
        AND lower(category) NOT LIKE '%transfer%' AND lower(category) NOT LIKE '%income%'
        AND lower(category) NOT LIKE '%loan_payments%' AND lower(category) NOT LIKE '%rent_and_utilities%'
        AND lower(category) NOT LIKE '%bank_fees%'
        AND julianday(:now_iso) - julianday(date) <= 30
      GROUP BY category
    ),
    base AS (
      SELECT category, SUM(ABS(amount_minor)) / 3.0 AS avg FROM transactions
      WHERE amount_minor < 0 AND category IS NOT NULL AND category <> ''
        AND lower(category) NOT LIKE '%transfer%' AND lower(category) NOT LIKE '%income%'
        AND lower(category) NOT LIKE '%loan_payments%' AND lower(category) NOT LIKE '%rent_and_utilities%'
        AND lower(category) NOT LIKE '%bank_fees%'
        AND julianday(:now_iso) - julianday(date) > 30 AND julianday(:now_iso) - julianday(date) <= 120
      GROUP BY category
    )
    SELECT
      cur.category AS key,
      UPPER(SUBSTR(REPLACE(lower(cur.category), '_', ' '), 1, 1)) || SUBSTR(REPLACE(lower(cur.category), '_', ' '), 2) || ' spending is up' AS title,
      money(CAST(cur.amt AS INT)) || ' in the last 30 days vs about ' || money(CAST(base.avg AS INT)) || ' in a typical month.' AS detail,
      '+' || money(CAST(cur.amt - base.avg AS INT)) AS value,
      CAST(cur.amt - base.avg AS INT) AS dollar_impact_minor,
      0.6 AS confidence,
      2 AS effort,
      'Last 30 days ' || money(CAST(cur.amt AS INT)) || ' vs 3-month average ' || money(CAST(base.avg AS INT)) || '.' AS evidence_summary,
      cur.category AS evidence_records,
      'Review this category' AS action_label,
      :now_iso AS created_at
    FROM cur JOIN base ON base.category = cur.category
    WHERE base.avg > 0 AND cur.amt >= base.avg * 1.4 AND (cur.amt - base.avg) >= 5000
    ORDER BY (cur.amt - base.avg) DESC
    LIMIT 5
  `,
};

// Spending: a recurring charge that only started recently — a new subscription or
// a free trial that has converted to paid. Fewer charges are required than for an
// established subscription, so recurrence is proved by a stable amount (2 charges)
// or a regular cadence (3+), never by merchant repetition alone.
const newRecurringCharge: Evaluator = {
  kind: 'new-recurring-charge',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /new subscription|new recurring|free trial|trial|新订阅|试用/,
  sql: `
    SELECT
      rs.merchant AS key,
      'New recurring charge: ' || COALESCE(rc.canonical_name, rs.label) AS title,
      'Recently started at ' || money(rs.latest_minor, rs.currency) || ' — about ' || money(CAST(ROUND(rs.latest_minor * rs.periods_per_year) AS INT), rs.currency) || '/yr if it continues.' AS detail,
      money(CAST(ROUND(rs.latest_minor * rs.periods_per_year) AS INT), rs.currency) AS value,
      CAST(ROUND(rs.latest_minor * rs.periods_per_year) AS INT) AS dollar_impact_minor,
      rs.currency,
      COALESCE(rc.confidence, 0.5) AS confidence,
      2 AS effort,
      'First seen ' || rs.first_date || ', ' || rs.count || ' charges of ~' || money(rs.latest_minor, rs.currency) || '.' AS evidence_summary,
      rs.record_ids AS evidence_records,
      'Confirm this is a subscription you want' AS action_label,
      rs.account_id AS account_id,
      rs.last_date AS created_at
    FROM recurring_series rs
    JOIN recurring_classifications rc ON rc.merchant = rs.merchant AND rc.direction = rs.direction
    WHERE rs.direction = 'out' AND rc.is_recurring = 1 AND rc.kind IN ('subscription', 'membership')
      AND rs.count >= 2 AND rs.count <= 4 AND fee_like(rs.label) = 0
      AND julianday(:now_iso) - julianday(rs.first_date) <= 50
      AND ROUND(rs.latest_minor * rs.periods_per_year) >= 6000
    LIMIT 10
  `,
};

// Cash flow: months of runway = liquid cash / average monthly spending. Surfaces
// only when runway is short. Risk-based, explicit severity, no dollar value.
const cashRunway: Evaluator = {
  kind: 'cash-runway',
  domain: 'cash-flow',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'banking',
  keywords: /runway|months of cash|cushion|emergency fund|现金储备|可支撑/,
  alwaysOn: true,
  sql: `
    WITH lb AS (
      SELECT b.*, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of_date DESC, id DESC) AS rn FROM account_balances b
    ),
    liquid AS (
      SELECT COUNT(*) AS cnt, COALESCE(SUM(MAX(0, COALESCE(lb.available_minor, lb.current_minor))), 0) AS amt
      FROM lb JOIN accounts a ON a.id = lb.account_id
      WHERE lb.rn = 1 AND a.domain <> 'brokerage'
        AND NOT (a.domain = 'credit' OR lower(a.type || ' ' || a.name) LIKE '%credit%' OR lower(a.type || ' ' || a.name) LIKE '%card%')
    ),
    spend AS (
      SELECT SUM(ABS(amount_minor)) / 3.0 AS monthly FROM transactions
      WHERE amount_minor < 0 AND julianday(:now_iso) - julianday(date) <= 90 AND lower(COALESCE(category, '')) NOT LIKE '%transfer%'
    )
    SELECT
      'runway' AS key,
      'Low cash runway' AS title,
      money(liquid.amt) || ' liquid against about ' || money(CAST(spend.monthly AS INT)) || '/mo spending — roughly ' || printf('%.1f', liquid.amt / spend.monthly) || ' months.' AS detail,
      printf('%.1f', liquid.amt / spend.monthly) || ' mo' AS value,
      0.7 AS confidence,
      CASE WHEN liquid.amt / spend.monthly < 1 THEN 'high' ELSE 'medium' END AS severity,
      CASE WHEN liquid.amt / spend.monthly < 1 THEN 1.5 ELSE 1 END AS urgency,
      'Liquid ' || money(liquid.amt) || ' / monthly spend ' || money(CAST(spend.monthly AS INT)) || '.' AS evidence_summary,
      '' AS evidence_records,
      :now_iso AS created_at
    FROM liquid CROSS JOIN spend
    WHERE liquid.cnt > 0 AND spend.monthly > 0 AND liquid.amt / spend.monthly < 2
  `,
};

// Connections: the freshest balance or transaction is well in the past, so the
// data behind every other finding may be stale. Prompts a resync.
const staleData: Evaluator = {
  kind: 'stale-data',
  domain: 'connections',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'all',
  keywords: /stale|out of date|not updated|needs refresh|过期|未更新/,
  alwaysOn: true,
  sql: `
    WITH newest AS (
      SELECT MAX(d) AS d FROM (
        SELECT MAX(as_of_date) AS d FROM account_balances
        UNION ALL SELECT MAX(date) FROM transactions
      )
    )
    SELECT
      'stale' AS key,
      'Account data may be stale' AS title,
      'Newest activity is about ' || CAST(ROUND(julianday(:now_iso) - julianday(n.d)) AS INT) || ' days old. Resync your connections to refresh balances and transactions.' AS detail,
      CAST(ROUND(julianday(:now_iso) - julianday(n.d)) AS INT) || 'd' AS value,
      0.8 AS confidence,
      'medium' AS severity,
      'Most recent balance/transaction is ' || CAST(ROUND(julianday(:now_iso) - julianday(n.d)) AS INT) || ' days old.' AS evidence_summary,
      '' AS evidence_records,
      'Resync connected accounts' AS action_label,
      :now_iso AS created_at
    FROM newest n
    WHERE n.d IS NOT NULL
      AND (SELECT COUNT(*) FROM accounts) > 0
      AND julianday(:now_iso) - julianday(n.d) >= 21
  `,
};




// Spending: the same subscription billed on more than one account — paying twice.
const crossCardSubscription: Evaluator = {
  kind: 'cross-card-subscription',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /duplicate subscription|two cards|paying twice|重复订阅/,
  alwaysOn: true,
  sql: `
    WITH s AS (
      SELECT rs.merchant AS merchant, rs.currency AS currency, rs.account_id AS account_id,
             COALESCE(rc.canonical_name, rs.label) AS label, rs.record_ids AS record_ids,
             CAST(ROUND(rs.latest_minor * rs.periods_per_year) AS INT) AS annual
      FROM recurring_series rs
      JOIN recurring_classifications rc ON rc.merchant = rs.merchant AND rc.direction = rs.direction
      WHERE rs.direction = 'out' AND rc.is_recurring = 1 AND rc.kind IN ('subscription', 'membership')
        AND fee_like(rs.label) = 0
    ),
    g AS (
      SELECT merchant, MIN(currency) AS currency, COUNT(DISTINCT account_id) AS accts,
             SUM(annual) AS total_annual, MAX(annual) AS max_annual,
             MIN(label) AS label, group_concat(record_ids) AS records
      FROM s GROUP BY merchant HAVING COUNT(DISTINCT account_id) >= 2
    )
    SELECT
      merchant AS key,
      'Duplicate subscription: ' || label AS title,
      'Billed on ' || accts || ' accounts — about ' || money(total_annual - max_annual, currency) || '/yr is a duplicate.' AS detail,
      money(total_annual - max_annual, currency) AS value,
      (total_annual - max_annual) AS dollar_impact_minor,
      currency,
      0.6 AS confidence,
      2 AS effort,
      'Same merchant recurring on ' || accts || ' accounts.' AS evidence_summary,
      records AS evidence_records,
      'Cancel the duplicate subscription' AS action_label,
      :now_iso AS created_at
    FROM g
    WHERE (total_annual - max_annual) >= 3000
  `,
};

// Spending: a large charge at a merchant with no prior history in the window.
const unfamiliarMerchantCharge: Evaluator = {
  kind: 'unfamiliar-merchant-charge',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'banking',
  keywords: /new merchant|unfamiliar|unrecognized|first[- ]time|陌生商户/,
  sql: `
    SELECT
      t.id AS key,
      'Large charge at a new merchant: ' || t.description AS title,
      money(t.amount_minor, t.currency) || ' on ' || t.date || ' — first charge seen at this merchant.' AS detail,
      money(t.amount_minor, t.currency) AS value,
      ABS(t.amount_minor) AS dollar_impact_minor,
      t.currency AS currency,
      0.4 AS confidence,
      2 AS effort,
      'No prior charge at ' || t.description || ' in the loaded history.' AS evidence_summary,
      t.id AS evidence_records,
      t.account_id AS account_id,
      t.created_at AS created_at
    FROM transactions t
    WHERE t.amount_minor < 0 AND ABS(t.amount_minor) >= 20000
      AND julianday(:now_iso) - julianday(t.date) <= 30
      AND normalize_merchant(t.description) <> ''
      AND normalize_merchant(t.description) NOT IN (
        SELECT normalize_merchant(description) FROM transactions
        WHERE amount_minor < 0 AND julianday(:now_iso) - julianday(date) > 30
      )
    ORDER BY ABS(t.amount_minor) DESC
    LIMIT 10
  `,
};

// Credit: interest charged on a card — the cost of carrying a balance.
const cardInterest: Evaluator = {
  kind: 'card-interest',
  domain: 'credit',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'credit',
  keywords: /card interest|carrying a balance|paying interest|信用卡利息/,
  sql: `
    WITH ci AS (
      SELECT t.account_id, ABS(t.amount_minor) AS amt, t.id
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.amount_minor < 0 AND julianday(:now_iso) - julianday(t.date) <= 90
        AND (a.domain = 'credit' OR lower(a.type || ' ' || a.name) LIKE '%credit%' OR lower(a.type || ' ' || a.name) LIKE '%card%')
        AND lower(t.description) LIKE '%interest%'
    )
    SELECT
      ci.account_id AS key,
      'You are paying interest on ' || COALESCE(a.name, 'a card') AS title,
      money(SUM(ci.amt)) || ' in interest over 90 days — about ' || money(CAST(ROUND(SUM(ci.amt) * 365.0 / 90) AS INT)) || '/yr from carrying a balance.' AS detail,
      money(CAST(ROUND(SUM(ci.amt) * 365.0 / 90) AS INT)) AS value,
      CAST(ROUND(SUM(ci.amt) * 365.0 / 90) AS INT) AS dollar_impact_minor,
      0.8 AS confidence,
      3 AS effort,
      'Interest charges on the card total ' || money(SUM(ci.amt)) || ' in 90 days.' AS evidence_summary,
      (SELECT group_concat(id) FROM (SELECT id FROM ci c2 WHERE c2.account_id = ci.account_id LIMIT 5)) AS evidence_records,
      'Pay down the balance to stop interest' AS action_label,
      ci.account_id AS account_id,
      :now_iso AS created_at
    FROM ci JOIN accounts a ON a.id = ci.account_id
    GROUP BY ci.account_id
  `,
};

// Cash flow: over the last 30 days spending outran income, drawing down savings.
const cashFlowNegative: Evaluator = {
  kind: 'cash-flow-negative',
  domain: 'cash-flow',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'banking',
  keywords: /cash flow|spending exceed|burning savings|入不敷出|现金流/,
  alwaysOn: true,
  sql: `
    WITH flows AS (
      SELECT
        SUM(CASE WHEN amount_minor > 0 AND lower(COALESCE(category, '')) NOT LIKE '%transfer%' THEN amount_minor ELSE 0 END) AS inflow,
        SUM(CASE WHEN amount_minor < 0 AND lower(COALESCE(category, '')) NOT LIKE '%transfer%' AND lower(COALESCE(category, '')) NOT LIKE '%loan_payments%' THEN ABS(amount_minor) ELSE 0 END) AS outflow
      FROM transactions WHERE julianday(:now_iso) - julianday(date) <= 30
    )
    SELECT
      'cashflow-30d' AS key,
      'Spending outpaced income this month' AS title,
      money(outflow) || ' out vs ' || money(inflow) || ' in over 30 days — ' || money(outflow - inflow) || ' drawn from savings.' AS detail,
      '-' || money(outflow - inflow) AS value,
      (outflow - inflow) AS dollar_impact_minor,
      0.6 AS confidence,
      2 AS effort,
      '30-day outflow ' || money(outflow) || ' exceeds inflow ' || money(inflow) || '.' AS evidence_summary,
      '' AS evidence_records,
      :now_iso AS created_at
    FROM flows
    WHERE inflow > 0 AND (outflow - inflow) >= 10000
  `,
};

// Cash flow: recurring bills coming due before the next expected deposit exceed
// the cash on hand — a forward-looking overdraft risk.
const upcomingBills: Evaluator = {
  kind: 'upcoming-bills',
  domain: 'cash-flow',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'banking',
  keywords: /bill runway|upcoming bills|due soon|账单|透支/,
  alwaysOn: true,
  sql: `
    WITH income AS (
      SELECT julianday(rs.last_date) + 365.0 / rs.periods_per_year AS next_jd
      FROM recurring_series rs
      JOIN recurring_classifications rc ON rc.merchant = rs.merchant AND rc.direction = rs.direction
      WHERE rs.direction = 'in' AND rc.is_recurring = 1
      ORDER BY rs.latest_minor DESC LIMIT 1
    ),
    window_end AS (
      SELECT MIN(COALESCE((SELECT next_jd FROM income), julianday(:now_iso) + 14), julianday(:now_iso) + 14) AS jd
    ),
    bills AS (
      SELECT rs.latest_minor AS latest_minor, (julianday(rs.last_date) + 365.0 / rs.periods_per_year) AS next_jd
      FROM recurring_series rs
      JOIN recurring_classifications rc ON rc.merchant = rs.merchant AND rc.direction = rs.direction
      WHERE rs.direction = 'out' AND rc.is_recurring = 1 AND fee_like(rs.label) = 0
    ),
    due AS (
      SELECT COALESCE(SUM(latest_minor), 0) AS amt, COUNT(*) AS n
      FROM bills CROSS JOIN window_end
      WHERE next_jd >= julianday(:now_iso) AND next_jd <= window_end.jd
    ),
    lb AS (
      SELECT b.*, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of_date DESC, id DESC) AS rn FROM account_balances b
    ),
    liquid AS (
      SELECT COALESCE(SUM(MAX(0, COALESCE(lb.available_minor, lb.current_minor))), 0) AS amt
      FROM lb JOIN accounts a ON a.id = lb.account_id
      WHERE lb.rn = 1 AND a.domain <> 'brokerage'
        AND NOT (a.domain = 'credit' OR lower(a.type || ' ' || a.name) LIKE '%credit%' OR lower(a.type || ' ' || a.name) LIKE '%card%')
    )
    SELECT
      'upcoming-bills' AS key,
      'Upcoming bills may overdraw you' AS title,
      'About ' || money(due.amt) || ' in bills due before your next deposit vs ' || money(liquid.amt) || ' available — ' || money(due.amt - liquid.amt) || ' short.' AS detail,
      '-' || money(due.amt - liquid.amt) AS value,
      (due.amt - liquid.amt) AS dollar_impact_minor,
      0.6 AS confidence,
      'high' AS severity,
      2 AS urgency,
      2 AS effort,
      due.n || ' recurring bills totaling ' || money(due.amt) || ' before the next deposit.' AS evidence_summary,
      '' AS evidence_records,
      'Move funds in before the bills hit' AS action_label,
      :now_iso AS created_at
    FROM due CROSS JOIN liquid
    WHERE due.amt > 0 AND liquid.amt < due.amt
  `,
};

// Cash flow: net worth fell materially month over month (drops only).
const netWorthMovement: Evaluator = {
  kind: 'net-worth-movement',
  domain: 'cash-flow',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'all',
  keywords: /net worth|net-worth|balance sheet|净值|资产净值/,
  sql: `
    WITH is_credit AS (
      SELECT id, (domain = 'credit' OR lower(type || ' ' || name) LIKE '%credit%' OR lower(type || ' ' || name) LIKE '%card%') AS credit FROM accounts
    ),
    asof AS (
      SELECT b.account_id, b.current_minor, b.as_of_date,
             ROW_NUMBER() OVER (PARTITION BY b.account_id ORDER BY b.as_of_date DESC, b.id DESC) AS rn_now,
             ROW_NUMBER() OVER (PARTITION BY b.account_id ORDER BY (b.as_of_date <= :prior_30d_iso) DESC, b.as_of_date DESC, b.id DESC) AS rn_prior
      FROM account_balances b
    ),
    nw AS (
      SELECT
        COALESCE(SUM(CASE WHEN c.credit THEN -MAX(0, n.current_minor) ELSE n.current_minor END), 0) AS now_nw,
        COALESCE(SUM(CASE WHEN c.credit THEN -MAX(0, p.current_minor) ELSE p.current_minor END), 0) AS prior_nw
      FROM (SELECT * FROM asof WHERE rn_now = 1) n
      JOIN is_credit c ON c.id = n.account_id
      LEFT JOIN (SELECT * FROM asof WHERE rn_prior = 1 AND as_of_date <= :prior_30d_iso) p ON p.account_id = n.account_id
    )
    SELECT
      'networth-30d' AS key,
      'Net worth dropped this month' AS title,
      money(now_nw) || ' now vs ' || money(prior_nw) || ' about 30 days ago — down ' || money(prior_nw - now_nw) || ' (' || CAST(ROUND(100.0 * (now_nw - prior_nw) / ABS(prior_nw)) AS INT) || '%).' AS detail,
      CAST(ROUND(100.0 * (now_nw - prior_nw) / ABS(prior_nw)) AS INT) || '%' AS value,
      ABS(now_nw - prior_nw) AS dollar_impact_minor,
      0.7 AS confidence,
      'medium' AS severity,
      'Net worth ' || money(prior_nw) || ' → ' || money(now_nw) || '.' AS evidence_summary,
      '' AS evidence_records,
      :now_iso AS created_at
    FROM nw
    WHERE prior_nw <> 0 AND (now_nw - prior_nw) <= -0.05 * ABS(prior_nw) AND ABS(now_nw - prior_nw) >= 100000
  `,
};

// Investments: recent executed buy/sell orders.
const executedTrades: Evaluator = {
  kind: 'executed-trades',
  domain: 'investments',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'brokerage',
  keywords: /executed|order|trade|bought|sold|成交|下单/,
  sql: `
    SELECT
      t.id AS key,
      (CASE WHEN lower(t.investment_type) LIKE '%sell%' THEN 'Sold ' ELSE 'Bought ' END) || COALESCE(t.symbol, t.description) AS title,
      COALESCE(a.name, 'Brokerage') || ' · ' || t.date || ' · ' || money(ABS(t.amount_minor), t.currency) AS detail,
      money(ABS(t.amount_minor), t.currency) AS value,
      ABS(t.amount_minor) AS dollar_impact_minor,
      t.currency AS currency,
      0.4 AS confidence,
      1 AS effort,
      'low' AS severity,
      COALESCE(t.investment_type, '') || ' ' || COALESCE(t.symbol, '') || ' ' || money(ABS(t.amount_minor), t.currency) || '.' AS evidence_summary,
      t.id AS evidence_records,
      t.account_id AS account_id,
      t.created_at AS created_at
    FROM brokerage_transactions t LEFT JOIN accounts a ON a.id = t.account_id
    WHERE julianday(:now_iso) - julianday(t.date) <= 30 AND (lower(t.investment_type) LIKE '%buy%' OR lower(t.investment_type) LIKE '%sell%')
    LIMIT 20
  `,
};

// Investments: dividends and interest received (tax-relevant income).
const dividendsReceived: Evaluator = {
  kind: 'dividends-received',
  domain: 'investments',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'brokerage',
  keywords: /dividend|股息|分红/,
  sql: `
    WITH inc AS (
      SELECT id, ABS(amount_minor) AS amt, currency
      FROM brokerage_transactions
      WHERE (lower(investment_type) LIKE '%dividend%' OR lower(investment_type) LIKE '%interest%')
        AND julianday(:now_iso) - julianday(date) <= 90
    )
    SELECT
      'dividends-90d' AS key,
      'You received ' || money(SUM(amt), MIN(currency)) || ' in dividends & interest' AS title,
      COUNT(*) || ' income payment(s) over 90 days — keep for tax time.' AS detail,
      money(SUM(amt), MIN(currency)) AS value,
      SUM(amt) AS dollar_impact_minor,
      MIN(currency) AS currency,
      0.6 AS confidence,
      1 AS effort,
      'low' AS severity,
      COUNT(*) || ' dividend/interest transactions.' AS evidence_summary,
      (SELECT group_concat(id) FROM (SELECT id FROM inc LIMIT 5)) AS evidence_records,
      :now_iso AS created_at
    FROM inc
    HAVING COUNT(*) > 0
  `,
};

// Investments: one position is an outsized share of total net worth.
const singleNameExposure: Evaluator = {
  kind: 'single-name-exposure',
  domain: 'investments',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'all',
  keywords: /single name|single stock|one position|net worth exposure|单一标的/,
  sql: `
    WITH latest_h AS (
      SELECT h.*, ROW_NUMBER() OVER (
        PARTITION BY account_id, COALESCE(security_id, symbol, name, security_type, ''), currency
        ORDER BY as_of_date DESC, created_at DESC, id DESC) AS rn
      FROM brokerage_holdings h
    ), h AS (SELECT * FROM latest_h WHERE rn = 1),
    latest_b AS (
      SELECT b.*, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of_date DESC, id DESC) AS rn FROM account_balances b
    ),
    liquid AS (
      SELECT COALESCE(SUM(MAX(0, lb.current_minor)), 0) AS amt
      FROM latest_b lb JOIN accounts a ON a.id = lb.account_id
      WHERE lb.rn = 1 AND NOT (a.domain = 'credit' OR lower(a.type || ' ' || a.name) LIKE '%credit%' OR lower(a.type || ' ' || a.name) LIKE '%card%')
    ),
    htot AS (SELECT COALESCE(SUM(value_minor), 0) AS amt FROM h),
    top AS (SELECT * FROM h ORDER BY value_minor DESC LIMIT 1)
    SELECT
      top.id AS key,
      COALESCE(top.symbol, top.name, 'One holding') || ' is ' || CAST(ROUND(100.0 * top.value_minor / (liquid.amt + htot.amt)) AS INT) || '% of your net worth' AS title,
      money(top.value_minor, top.currency) || ' in a single position out of ' || money(liquid.amt + htot.amt, top.currency) || ' tracked assets.' AS detail,
      CAST(ROUND(100.0 * top.value_minor / (liquid.amt + htot.amt)) AS INT) || '%' AS value,
      0.7 AS confidence,
      CASE WHEN 1.0 * top.value_minor / (liquid.amt + htot.amt) >= 0.3 THEN 'high' ELSE 'medium' END AS severity,
      'Largest position is ' || CAST(ROUND(100.0 * top.value_minor / (liquid.amt + htot.amt)) AS INT) || '% of total assets.' AS evidence_summary,
      top.id AS evidence_records,
      top.account_id AS account_id,
      top.created_at AS created_at
    FROM top CROSS JOIN liquid CROSS JOIN htot
    WHERE (liquid.amt + htot.amt) > 0 AND top.value_minor > 0 AND 1.0 * top.value_minor / (liquid.amt + htot.amt) >= 0.15
  `,
};

// Investments: a holding's value swung sharply since the prior snapshot.
const holdingSwing: Evaluator = {
  kind: 'holding-swing',
  domain: 'investments',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'brokerage',
  keywords: /holding move|value swing|price swing|持仓波动|价格波动/,
  sql: `
    WITH snaps AS (
      SELECT account_id, COALESCE(symbol, security_id, name) AS sec, symbol, name, currency, value_minor, as_of_date, id,
             DENSE_RANK() OVER (PARTITION BY account_id, COALESCE(symbol, security_id, name) ORDER BY as_of_date DESC) AS drank
      FROM brokerage_holdings
    ),
    pair AS (
      SELECT account_id, sec,
        MAX(CASE WHEN drank = 1 THEN value_minor END) AS latest_v,
        MAX(CASE WHEN drank = 1 THEN symbol END) AS symbol,
        MAX(CASE WHEN drank = 1 THEN name END) AS name,
        MAX(CASE WHEN drank = 1 THEN currency END) AS currency,
        MAX(CASE WHEN drank = 1 THEN id END) AS latest_id,
        MAX(CASE WHEN drank = 1 THEN as_of_date END) AS latest_date,
        MAX(CASE WHEN drank = 2 THEN value_minor END) AS prior_v,
        MAX(CASE WHEN drank = 2 THEN as_of_date END) AS prior_date,
        MAX(CASE WHEN drank = 2 THEN id END) AS prior_id
      FROM snaps WHERE drank <= 2 GROUP BY account_id, sec
    )
    SELECT
      account_id || ':' || COALESCE(symbol, name) AS key,
      COALESCE(symbol, name, 'A holding') || ' moved ' || (CASE WHEN latest_v > prior_v THEN '+' ELSE '' END) || CAST(ROUND(100.0 * (latest_v - prior_v) / prior_v) AS INT) || '%' AS title,
      money(prior_v, currency) || ' → ' || money(latest_v, currency) || ' since ' || prior_date || '.' AS detail,
      (CASE WHEN latest_v > prior_v THEN '+' ELSE '' END) || CAST(ROUND(100.0 * (latest_v - prior_v) / prior_v) AS INT) || '%' AS value,
      ABS(latest_v - prior_v) AS dollar_impact_minor,
      currency,
      0.7 AS confidence,
      'medium' AS severity,
      prior_date || ' → ' || latest_date || ': ' || money(prior_v, currency) || ' → ' || money(latest_v, currency) || '.' AS evidence_summary,
      prior_id || ',' || latest_id AS evidence_records,
      account_id AS account_id,
      latest_date AS created_at
    FROM pair
    WHERE prior_v > 0 AND ABS(latest_v - prior_v) * 1.0 / prior_v >= 0.15 AND ABS(latest_v - prior_v) >= 100000
    ORDER BY ABS(latest_v - prior_v) DESC
    LIMIT 10
  `,
};

// Investments: a symbol sold and repurchased within 30 days — a possible wash
// sale worth a manual review at tax time (no cost basis, so review only).
const washSaleRisk: Evaluator = {
  kind: 'wash-sale-risk',
  domain: 'investments',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'brokerage',
  keywords: /wash sale|洗售|亏损卖出/,
  sql: `
    SELECT
      s.symbol || ':' || s.id AS key,
      'Possible wash sale: ' || s.symbol AS title,
      'Sold ' || s.symbol || ' on ' || s.date || ' and bought it again near ' || MIN(b.date) || ' — if the sale was at a loss, that loss may be disallowed.' AS detail,
      s.symbol AS value,
      0.5 AS confidence,
      'medium' AS severity,
      3 AS effort,
      'Sell ' || s.date || ' and buy ' || MIN(b.date) || ' of ' || s.symbol || ' within 30 days.' AS evidence_summary,
      s.id || ',' || MIN(b.id) AS evidence_records,
      'Review for a wash sale before filing' AS action_label,
      s.account_id AS account_id,
      s.created_at AS created_at
    FROM brokerage_transactions s JOIN brokerage_transactions b
      ON b.symbol = s.symbol AND lower(b.investment_type) LIKE '%buy%'
      AND ABS(julianday(b.date) - julianday(s.date)) <= 30
    WHERE s.symbol IS NOT NULL AND lower(s.investment_type) LIKE '%sell%'
    GROUP BY s.symbol
    LIMIT 10
  `,
};

// Order matters for natural-language inference: the first evaluator whose
// keywords match wins, so specific evaluators precede the broad idle-cash and
// large-transaction fallbacks.
const EVALUATORS: Evaluator[] = [
  connectionHealth,
  staleData,
  creditUtilization,
  cardInterest,
  employerMatch,
  cashRunway,
  cashFlowNegative,
  lowBalance,
  upcomingBills,
  netWorthMovement,
  feesAndInterest,
  subscriptionPriceIncrease,
  crossCardSubscription,
  newRecurringCharge,
  recurringSubscriptions,
  spendingCategorySpike,
  duplicateCharge,
  unfamiliarMerchantCharge,
  idleBrokerageCash,
  portfolioConcentration,
  singleNameExposure,
  holdingSwing,
  executedTrades,
  dividendsReceived,
  washSaleRisk,
  // Broad-keyword fallbacks last: idle-cash matches "cash", large-transaction
  // matches "charge"/"transaction", so more specific evaluators win inference.
  idleCash,
  largeTransaction,
];

// The built-in rules as DATA, seeded into the rule_specs table on startup. From
// then on the engine reads every spec (built-in + downloaded) from the table, so
// adding a rule is a data change — no code. See docs/rules-design.md.
export function builtinRuleSpecs(): RuleSpec[] {
  return EVALUATORS.map((e) => ({
    kind: e.kind,
    domain: e.domain,
    executionClass: e.executionClass,
    actionTier: e.defaultTier,
    scope: e.scope,
    cadence: 'event',
    alwaysOn: e.alwaysOn ?? false,
    keywords: e.keywords.source,
    sql: e.sql ?? null,
    prompt: null,
    facts: (e.facts ?? []).map((f) => ({
      key: f.key,
      prompt: f.prompt,
      unlockImpactMinor: f.unlockImpactMinor,
      ...(f.currency ? { currency: f.currency } : {}),
      ...(f.expects ? { expects: f.expects } : {}),
    })),
    enabled: true,
    source: 'builtin',
    version: 1,
  }));
}

// ── Interpreter ──────────────────────────────────────────────────────────────

function finalize(rule: RuleRecord, spec: RuleSpec, draft: Draft): Finding {
  const dollarImpactMinor = draft.dollarImpactMinor ?? 0;
  const currency = draft.currency ?? 'USD';
  const urgency = draft.urgency ?? 1;
  const effort = draft.effort ?? 1;
  const confidence = Math.max(0, Math.min(1, draft.confidence));
  const score = Math.round((Math.abs(dollarImpactMinor) * confidence * urgency) / Math.max(1, effort));
  const severity = draft.severity ?? deriveSeverity(score);
  const tier = capTier(rule.actionTier, confidence);
  return {
    id: `${rule.kind}:${rule.id || 'builtin'}:${draft.key}`,
    ruleId: rule.id || null,
    kind: rule.kind,
    domain: spec.domain,
    scope: rule.scope,
    title: draft.title,
    detail: draft.detail,
    value: draft.value,
    dollarImpactMinor,
    currency,
    confidence,
    urgency,
    effort,
    score,
    severity,
    actionTier: tier,
    action: draft.actionLabel ? { tier, label: draft.actionLabel, artifact: null } : null,
    evidence: draft.evidence,
    ...(draft.accountId ? { accountId: draft.accountId } : {}),
    createdAt: draft.createdAt,
  };
}

// A synthetic rule for always-on specs that have no stored rule.
function builtinRule(spec: RuleSpec, nowIso: string): RuleRecord {
  return {
    id: '',
    kind: spec.kind,
    domain: spec.domain,
    sourceText: `Built-in ${spec.kind}`,
    executionClass: spec.executionClass,
    actionTier: spec.actionTier,
    scope: spec.scope,
    cadence: spec.cadence,
    channel: 'auto',
    scheduledHour: null,
    scheduledDay: null,
    enabled: true,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

// Evaluate enabled rules plus any always-on spec not already covered by a stored
// rule, resolving each rule's definition from the given specs (loaded from the
// rule_specs table). A rule blocked on a missing required fact yields a question
// instead of a finding. Findings below the suppression floor are dropped unless
// they carry an explicit non-low severity. The caller applies mutes and delivery.
export function evaluateRules(specs: RuleSpec[], rules: RuleRecord[], data: EvaluationData, runQuery: RuleQueryRunner): EngineResult {
  const registry = new Map(specs.filter((s) => s.enabled).map((s) => [s.kind, s]));
  const findings: Finding[] = [];
  const questions = new Map<string, QuestionDraft>();
  const enabled = rules.filter((rule) => rule.enabled);
  const covered = new Set(enabled.map((rule) => rule.kind));
  const nowIso = new Date(data.nowMs).toISOString();

  const runnable: RuleRecord[] = [
    ...enabled,
    ...specs.filter((s) => s.enabled && s.alwaysOn && !covered.has(s.kind)).map((s) => builtinRule(s, nowIso)),
  ];

  for (const rule of runnable) {
    const spec = registry.get(rule.kind);
    if (!spec) continue;
    const missing = spec.facts.filter((need) => !data.facts.has(need.key));
    if (missing.length > 0) {
      for (const need of missing) {
        questions.set(need.key, {
          factKey: need.key,
          prompt: need.prompt,
          ruleKind: rule.kind,
          unlockImpactMinor: need.unlockImpactMinor,
          currency: need.currency ?? 'USD',
          suggestedValue: null,
        });
      }
      continue; // blocked on a fact — produces a question, not a finding
    }
    if (!spec.sql) continue; // prompt/LLM specs run once the L/L+ path exists
    const rows = runQuery(spec.sql, {
      rule_id: rule.id || '',
      rule_created_at: rule.createdAt,
      now_iso: nowIso,
      now_ms: data.nowMs,
      prior_30d_iso: new Date(data.nowMs - 30 * 86_400_000).toISOString(),
      hysa_apr: REFERENCE_TABLES.highYieldSavingsApr,
      checking_apr: REFERENCE_TABLES.checkingApr,
    });
    for (const draft of rows.map(rowToDraft)) {
      const finding = finalize(rule, spec, draft);
      if (finding.score >= SUPPRESS_SCORE || finding.severity !== 'low') findings.push(finding);
    }
  }

  findings.sort((a, b) => b.score - a.score);
  return { findings, questions: [...questions.values()].sort((a, b) => b.unlockImpactMinor - a.unlockImpactMinor) };
}

// ── Natural-language rule inference ──────────────────────────────────────────

interface InferredRule {
  kind: string;
  domain: RuleDomain;
  executionClass: RuleExecutionClass;
  actionTier: RuleActionTier;
  scope: string;
  cadence: string;
  channel: string;
}

const SCOPES = ['banking', 'brokerage', 'credit', 'all'];
const CADENCES = ['event', 'hourly', 'daily', 'weekly', 'monthly'];

function inferCadence(lower: string): string {
  if (/monthly|month|每月/.test(lower)) return 'monthly';
  if (/weekly|week|每周/.test(lower)) return 'weekly';
  if (/daily|day|每天|每日/.test(lower)) return 'daily';
  if (/hourly|hour|每小时/.test(lower)) return 'hourly';
  return 'event';
}

// Match the first spec whose keyword pattern hits (specs are ordered specific ->
// broad by the seed), falling back to large-transaction.
export function inferRule(specs: RuleSpec[], text: string, scope?: string, cadence?: string): InferredRule {
  const lower = text.toLowerCase();
  const match = specs.find((s) => s.keywords && new RegExp(s.keywords, 'i').test(lower))
    ?? specs.find((s) => s.kind === 'large-transaction')
    ?? specs[0];
  const chosenScope = (scope && SCOPES.includes(scope) ? scope : match?.scope ?? 'banking');
  const chosenCadence = (cadence && CADENCES.includes(cadence) ? cadence : inferCadence(lower));
  return {
    kind: match?.kind ?? 'large-transaction',
    domain: match?.domain ?? 'spending',
    executionClass: match?.executionClass ?? 'D',
    actionTier: match?.actionTier ?? 'observer',
    scope: SCOPES.includes(chosenScope) ? chosenScope : 'banking',
    cadence: CADENCES.includes(chosenCadence) ? chosenCadence : 'event',
    channel: 'auto',
  };
}

export function executionStrategy(executionClass: RuleExecutionClass): string {
  if (executionClass === 'D') return 'Deterministic query and local copy; no model runs at evaluation time.';
  if (executionClass === 'L') return 'Deterministic trigger with a model-generated explanation from local facts.';
  return 'Deterministic prefilter, then model admit/reject with a deterministic fallback.';
}
