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
  Account,
  AccountBalance,
  BrokerageHolding,
  BrokerageTransaction,
  FactRecord,
  Finding,
  FindingEvidence,
  ProviderConnection,
  RuleActionTier,
  RuleDomain,
  RuleExecutionClass,
  RuleRecord,
  Transaction,
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

export interface EvaluationData {
  accounts: Account[];
  balances: AccountBalance[]; // latest per account
  transactions: Transaction[];
  brokerageTransactions: BrokerageTransaction[];
  holdings: BrokerageHolding[];
  connections: ProviderConnection[];
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
  suggest?: (data: EvaluationData) => string | null; // derive-then-confirm
}

interface Evaluator {
  kind: string;
  domain: RuleDomain;
  executionClass: RuleExecutionClass;
  defaultTier: RuleActionTier;
  scope: string;
  keywords: RegExp; // for natural-language rule inference
  alwaysOn?: boolean; // runs even with no stored rule of this kind
  facts?: FactNeed[];
  run(rule: RuleRecord, data: EvaluationData): Draft[];
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

function money(amountMinor: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amountMinor / 100);
  } catch {
    return `${currency || 'USD'} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function isCreditAccount(account: Account | undefined): boolean {
  if (!account) return false;
  return account.domain === 'credit' || /credit|card/i.test(`${account.type || ''} ${account.name || ''}`);
}

function annualNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// A percentage fact may be entered as "6" or "0.06"; normalize to a fraction.
function pctFraction(value: string | undefined): number | null {
  const n = annualNumber(value);
  if (n == null) return null;
  return n > 1 ? n / 100 : n;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// Collapse a merchant description to a stable grouping key: lowercase, drop
// digits and punctuation so "NETFLIX 8842" and "Netflix#1190" group together.
function normalizeMerchant(description: string): string {
  return description
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z一-鿿 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

interface RecurringSeries {
  merchant: string;
  label: string; // original latest description, for display
  accountId: string;
  currency: string;
  typicalMinor: number; // median of prior charges, for increase comparison
  latestMinor: number;
  count: number;
  periodsPerYear: number;
  recordIds: string[];
  firstDate: string;
  lastDate: string;
}

// Deterministic recurring-charge detection over the outflow stream: group by
// normalized merchant, keep series of >= minCount charges spanning >= minSpanDays,
// and estimate cadence from the average gap. No user input; feeds subscription and
// new-charge rules. Established subscriptions use the strict defaults; newly
// started ones are found with a relaxed minimum.
function detectRecurring(transactions: Transaction[], nowMs: number, opts: { minCount?: number; minSpanDays?: number } = {}): RecurringSeries[] {
  const minCount = opts.minCount ?? 3;
  const minSpanDays = opts.minSpanDays ?? 60;
  const horizon = nowMs - 400 * 86_400_000;
  const groups = new Map<string, Transaction[]>();
  for (const txn of transactions) {
    if (txn.amountMinor >= 0) continue;
    const time = new Date(txn.date).getTime();
    const key = normalizeMerchant(txn.description);
    if (!key || !Number.isFinite(time) || time < horizon) continue;
    const groupKey = `${txn.accountId}:${key}`;
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(txn);
    else groups.set(groupKey, [txn]);
  }
  const series: RecurringSeries[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < minCount) continue;
    const sorted = bucket.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const spanDays = (new Date(sorted[sorted.length - 1]!.date).getTime() - new Date(sorted[0]!.date).getTime()) / 86_400_000;
    if (spanDays < minSpanDays) continue;
    const amounts = sorted.map((t) => Math.abs(t.amountMinor));
    const latest = sorted[sorted.length - 1]!;
    series.push({
      merchant: normalizeMerchant(latest.description),
      label: latest.description,
      accountId: latest.accountId,
      currency: latest.currency,
      typicalMinor: median(amounts.slice(0, -1)),
      latestMinor: Math.abs(latest.amountMinor),
      count: sorted.length,
      periodsPerYear: Math.max(1, Math.min(52, 365 / (spanDays / (sorted.length - 1)))),
      recordIds: sorted.slice(-4).map((t) => t.id),
      firstDate: sorted[0]!.date,
      lastDate: latest.date,
    });
  }
  return series;
}

// Plaid personal-finance categories that are not discretionary spending, excluded
// from the category-spike and runway rules.
const NON_DISCRETIONARY_CATEGORY = /transfer|income|loan_payments|rent_and_utilities|bank_fees/i;

function prettyCategory(category: string): string {
  const text = category.replace(/_/g, ' ').toLowerCase().trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Spending';
}

const FEE_PATTERN = /\b(fee|fees|overdraft|nsf|service charge|atm|late charge|late fee|interest charge|finance charge|maintenance fee|surcharge|annual fee)\b/i;

// ── Evaluators ───────────────────────────────────────────────────────────────

const idleCash: Evaluator = {
  kind: 'idle-cash',
  domain: 'cash-flow',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /idle|cash|savings|high[- ]?yield|hysa|现金|闲置/,
  run(rule, data) {
    const spread = REFERENCE_TABLES.highYieldSavingsApr - REFERENCE_TABLES.checkingApr;
    return data.balances
      .filter((balance) => {
        const account = data.accounts.find((a) => a.id === balance.accountId);
        if (!account || account.domain === 'brokerage') return false;
        const cash = balance.availableMinor ?? balance.currentMinor;
        return balance.currentMinor > 0 && cash !== null && cash / balance.currentMinor >= 0.3;
      })
      .map((balance) => {
        const account = data.accounts.find((a) => a.id === balance.accountId);
        const cash = balance.availableMinor ?? balance.currentMinor;
        const impact = Math.round(cash * spread); // one year of forgone yield
        return {
          key: balance.accountId,
          title: `${account?.name || 'Account'} has idle cash`,
          detail: `${money(cash, balance.currency)} sitting at roughly ${(REFERENCE_TABLES.checkingApr * 100).toFixed(2)}% could earn about ${money(impact, balance.currency)}/yr at ${(REFERENCE_TABLES.highYieldSavingsApr * 100).toFixed(1)}%.`,
          value: money(impact, balance.currency),
          dollarImpactMinor: impact,
          currency: balance.currency,
          confidence: 0.8,
          effort: 3,
          evidence: { summary: `Available cash ${money(cash, balance.currency)} priced against the ${REFERENCE_TABLES.version} savings benchmark.`, records: [balance.accountId] },
          actionLabel: 'Move to a high-yield savings account',
          accountId: balance.accountId,
          createdAt: balance.createdAt,
        } satisfies Draft;
      });
  },
};

const idleBrokerageCash: Evaluator = {
  kind: 'idle-brokerage-cash',
  domain: 'investments',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'brokerage',
  keywords: /cash drag|brokerage cash|sweep|uninvested|现金拖累/,
  alwaysOn: true,
  run(rule, data) {
    const apr = REFERENCE_TABLES.highYieldSavingsApr;
    return data.balances
      .filter((balance) => {
        const account = data.accounts.find((a) => a.id === balance.accountId);
        return account?.domain === 'brokerage' && balance.currentMinor > 0 && balance.cashMinor !== null && balance.cashMinor / balance.currentMinor >= 0.3;
      })
      .map((balance) => {
        const account = data.accounts.find((a) => a.id === balance.accountId);
        const cash = balance.cashMinor ?? 0;
        const impact = Math.round(cash * apr);
        return {
          key: balance.accountId,
          title: `${account?.name || 'Brokerage'} cash drag`,
          detail: `${money(cash, balance.currency)} uninvested of ${money(balance.currentMinor, balance.currency)}; about ${money(impact, balance.currency)}/yr in a swept money-market rate.`,
          value: `${Math.round((cash / balance.currentMinor) * 100)}%`,
          dollarImpactMinor: impact,
          currency: balance.currency,
          confidence: 0.7,
          effort: 2,
          evidence: { summary: `Uninvested cash ${money(cash, balance.currency)} of ${money(balance.currentMinor, balance.currency)}.`, records: [balance.accountId] },
          actionLabel: 'Invest or sweep the idle cash',
          accountId: balance.accountId,
          createdAt: balance.createdAt,
        } satisfies Draft;
      });
  },
};

const largeTransaction: Evaluator = {
  kind: 'large-transaction',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'banking',
  keywords: /large|big|unusual|charge|transaction|spend|消费|大额/,
  run(rule, data) {
    return data.transactions
      .filter((txn) => txn.createdAt >= rule.createdAt && txn.amountMinor < 0 && Math.abs(txn.amountMinor) >= 50_000)
      .slice(0, 20)
      .map((txn) => {
        const account = data.accounts.find((a) => a.id === txn.accountId);
        const magnitude = Math.abs(txn.amountMinor);
        return {
          key: txn.id,
          title: `Large transaction: ${txn.description}`,
          detail: `${account?.name || 'Account'} · ${txn.date} · ${money(txn.amountMinor, txn.currency)}`,
          value: money(txn.amountMinor, txn.currency),
          dollarImpactMinor: magnitude,
          currency: txn.currency,
          confidence: 0.5, // awareness: probably legitimate, low actionability
          effort: 2,
          evidence: { summary: `Outflow of ${money(magnitude, txn.currency)} on ${txn.date}.`, records: [txn.id] },
          accountId: txn.accountId,
          createdAt: txn.createdAt,
        } satisfies Draft;
      });
  },
};

const duplicateCharge: Evaluator = {
  kind: 'duplicate-charge',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /duplicate|double|charged twice|重复|重复扣费/,
  run(rule, data) {
    const drafts: Draft[] = [];
    const recent = data.transactions
      .filter((txn) => txn.createdAt >= rule.createdAt && txn.amountMinor < 0)
      .slice(0, 200);
    const seen = new Map<string, Transaction>();
    for (const txn of recent) {
      const merchant = txn.description.trim().toLowerCase().slice(0, 24);
      const groupKey = `${txn.accountId}:${txn.amountMinor}:${merchant}`;
      const prior = seen.get(groupKey);
      if (prior) {
        const daysApart = Math.abs(new Date(txn.date).getTime() - new Date(prior.date).getTime()) / 86_400_000;
        if (Number.isFinite(daysApart) && daysApart <= 3) {
          const magnitude = Math.abs(txn.amountMinor);
          drafts.push({
            key: `${prior.id}:${txn.id}`,
            title: `Possible duplicate charge: ${txn.description}`,
            detail: `${money(txn.amountMinor, txn.currency)} on ${prior.date} and ${txn.date}.`,
            value: money(magnitude, txn.currency),
            dollarImpactMinor: magnitude,
            currency: txn.currency,
            confidence: 0.55,
            effort: 3,
            evidence: { summary: `Two charges of ${money(magnitude, txn.currency)} within ${Math.round(daysApart)} day(s).`, records: [prior.id, txn.id] },
            actionLabel: 'Review and dispute the duplicate',
            accountId: txn.accountId,
            createdAt: txn.createdAt,
          });
        }
      }
      seen.set(groupKey, txn);
    }
    return drafts.slice(0, 20);
  },
};

const portfolioConcentration: Evaluator = {
  kind: 'portfolio-concentration',
  domain: 'investments',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'brokerage',
  keywords: /concentration|portfolio|holding|allocation|持仓|集中/,
  alwaysOn: true,
  run(rule, data) {
    const total = data.holdings.reduce((sum, h) => sum + h.valueMinor, 0);
    const largest = data.holdings.slice().sort((a, b) => b.valueMinor - a.valueMinor)[0];
    if (!largest || total <= 0 || largest.valueMinor / total < 0.2) return [];
    const account = data.accounts.find((a) => a.id === largest.accountId);
    const ratio = largest.valueMinor / total;
    return [{
      key: largest.id,
      title: `${largest.symbol || largest.name || 'Top holding'} concentration`,
      detail: `${account?.name || 'Brokerage'} holds ${money(largest.valueMinor, largest.currency)} of ${money(total, largest.currency)} tracked holdings.`,
      value: `${Math.round(ratio * 100)}%`,
      confidence: 0.7,
      severity: ratio >= 0.4 ? 'high' : 'medium',
      evidence: { summary: `Largest holding is ${Math.round(ratio * 100)}% of tracked value.`, records: [largest.id] },
      accountId: largest.accountId,
      createdAt: largest.createdAt,
    }];
  },
};

const creditUtilization: Evaluator = {
  kind: 'credit-utilization',
  domain: 'credit',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'credit',
  keywords: /utilization|credit|card|score|信用|利用率/,
  run(rule, data) {
    return data.balances
      .filter((balance) => {
        const account = data.accounts.find((a) => a.id === balance.accountId);
        return isCreditAccount(account) && balance.limitMinor !== null && balance.limitMinor > 0 && balance.currentMinor > 0 && balance.currentMinor / balance.limitMinor >= 0.3;
      })
      .map((balance) => {
        const account = data.accounts.find((a) => a.id === balance.accountId);
        const ratio = balance.currentMinor / (balance.limitMinor as number);
        return {
          key: balance.accountId,
          title: `${account?.name || 'Credit account'} utilization is elevated`,
          detail: `${money(balance.currentMinor, balance.currency)} balance on ${money(balance.limitMinor || 0, balance.currency)} limit.`,
          value: `${Math.round(ratio * 100)}%`,
          confidence: 0.9,
          severity: ratio >= 0.7 ? 'high' : 'medium',
          urgency: ratio >= 0.7 ? 1.5 : 1,
          evidence: { summary: `Utilization ${Math.round(ratio * 100)}% before statement close.`, records: [balance.accountId] },
          actionLabel: 'Pay down before the statement closes',
          accountId: balance.accountId,
          createdAt: balance.createdAt,
        } satisfies Draft;
      });
  },
};

const connectionHealth: Evaluator = {
  kind: 'connection-health',
  domain: 'connections',
  executionClass: 'D',
  defaultTier: 'observer',
  scope: 'all',
  keywords: /connection|sync|token|cursor|plaid|snaptrade|link/,
  alwaysOn: true,
  run(rule, data) {
    return data.connections
      .filter((c) => c.status !== 'active' || !c.hasAccessToken || (c.provider === 'plaid' && !c.hasCursor))
      .map((c) => ({
        key: `${c.provider}:${c.externalId}`,
        title: `${c.institution || c.provider} connection needs review`,
        detail: `Status ${c.status}; token saved: ${c.hasAccessToken ? 'yes' : 'no'}; cursor saved: ${c.hasCursor ? 'yes' : 'no'}.`,
        value: 'Review',
        confidence: 0.95,
        severity: 'high' as const,
        evidence: { summary: `Provider connection is not fully healthy.`, records: [`${c.provider}:${c.externalId}`] },
        createdAt: c.updatedAt,
      } satisfies Draft));
  },
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
  facts: [
    { key: 'annual_income', prompt: 'What is your gross annual salary?', unlockImpactMinor: 240_000 },
    { key: 'retirement_contribution_pct', prompt: 'What percent of salary do you contribute to your 401(k)?', unlockImpactMinor: 240_000 },
    { key: 'employer_match_pct', prompt: 'Up to what percent of salary does your employer match?', unlockImpactMinor: 240_000 },
  ],
  run(rule, data) {
    const income = annualNumber(data.facts.get('annual_income')?.value);
    const contrib = pctFraction(data.facts.get('retirement_contribution_pct')?.value);
    const match = pctFraction(data.facts.get('employer_match_pct')?.value);
    if (income == null || contrib == null || match == null) return [];
    const missedFraction = Math.max(0, match - contrib);
    if (missedFraction <= 0) return [];
    const impact = Math.round(income * 100 * missedFraction); // income is major units; convert to minor
    // Confidence blends the confidence of the facts the estimate rests on.
    const factConfidence = Math.min(
      data.facts.get('annual_income')?.confidence ?? 0.7,
      data.facts.get('retirement_contribution_pct')?.confidence ?? 0.7,
      data.facts.get('employer_match_pct')?.confidence ?? 0.7,
    );
    return [{
      key: 'employer-match',
      title: 'You are leaving employer 401(k) match on the table',
      detail: `Contributing ${(contrib * 100).toFixed(1)}% against a ${(match * 100).toFixed(1)}% match forgoes about ${money(impact)}/yr in free money.`,
      value: `${money(impact)}/yr`,
      dollarImpactMinor: impact,
      confidence: factConfidence,
      effort: 3,
      evidence: { summary: `Match ${(match * 100).toFixed(1)}% minus contribution ${(contrib * 100).toFixed(1)}% on ${money(income * 100)} income.`, records: ['fact:employer_match_pct', 'fact:retirement_contribution_pct', 'fact:annual_income'] },
      actionLabel: 'Raise contribution to at least the full match',
      createdAt: new Date(data.nowMs).toISOString(),
    }];
  },
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
  run(rule, data) {
    return data.balances
      .filter((balance) => {
        const account = data.accounts.find((a) => a.id === balance.accountId);
        return Boolean(account) && account!.domain !== 'brokerage' && !isCreditAccount(account) && balance.currentMinor < 10_000;
      })
      .map((balance) => {
        const account = data.accounts.find((a) => a.id === balance.accountId);
        const overdrawn = balance.currentMinor < 0;
        return {
          key: balance.accountId,
          title: overdrawn ? `${account?.name || 'Account'} is overdrawn` : `${account?.name || 'Account'} balance is low`,
          detail: `Current balance ${money(balance.currentMinor, balance.currency)}.`,
          value: money(balance.currentMinor, balance.currency),
          confidence: 0.95,
          severity: overdrawn ? 'high' as const : 'medium' as const,
          urgency: overdrawn ? 2 : 1,
          evidence: { summary: `Balance ${money(balance.currentMinor, balance.currency)} on a spending account.`, records: [balance.accountId] },
          ...(overdrawn ? { actionLabel: 'Transfer funds to avoid overdraft fees' } : {}),
          accountId: balance.accountId,
          createdAt: balance.createdAt,
        } satisfies Draft;
      });
  },
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
  run(rule, data) {
    const windowStart = data.nowMs - 90 * 86_400_000;
    const fees = data.transactions.filter((txn) => {
      const time = new Date(txn.date).getTime();
      return txn.amountMinor < 0 && Number.isFinite(time) && time >= windowStart && FEE_PATTERN.test(txn.description);
    });
    if (fees.length === 0) return [];
    const sum = fees.reduce((total, txn) => total + Math.abs(txn.amountMinor), 0);
    const annual = Math.round(sum * (365 / 90));
    const currency = fees[0]!.currency;
    return [{
      key: 'fees-90d',
      title: `You paid ${money(sum, currency)} in fees & interest`,
      detail: `${fees.length} fee or interest charge(s) in the last 90 days — about ${money(annual, currency)}/yr.`,
      value: money(annual, currency),
      dollarImpactMinor: annual,
      currency,
      confidence: 0.7,
      effort: 3,
      evidence: { summary: `Sum of ${fees.length} fee/interest charges over 90 days.`, records: fees.slice(0, 10).map((t) => t.id) },
      actionLabel: 'Review and dispute avoidable fees',
      createdAt: new Date(data.nowMs).toISOString(),
    }];
  },
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
  run(rule, data) {
    return detectRecurring(data.transactions, data.nowMs)
      .filter((s) => !FEE_PATTERN.test(s.label) && s.typicalMinor > 0 && s.latestMinor > s.typicalMinor * 1.1)
      .map((s) => {
        const annualDelta = Math.round((s.latestMinor - s.typicalMinor) * s.periodsPerYear);
        return {
          key: s.merchant,
          title: `${s.label} charge went up`,
          detail: `Now ${money(s.latestMinor, s.currency)} vs a usual ${money(s.typicalMinor, s.currency)} — about ${money(annualDelta, s.currency)}/yr more.`,
          value: money(annualDelta, s.currency),
          dollarImpactMinor: annualDelta,
          currency: s.currency,
          confidence: 0.6,
          effort: 2,
          evidence: { summary: `Latest ${money(s.latestMinor, s.currency)} exceeds prior median ${money(s.typicalMinor, s.currency)} across ${s.count} charges.`, records: s.recordIds },
          actionLabel: 'Review or renegotiate the increase',
          accountId: s.accountId,
          createdAt: s.lastDate,
        } satisfies Draft;
      })
      .filter((draft) => (draft.dollarImpactMinor ?? 0) >= 1_200);
  },
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
  run(rule, data) {
    return detectRecurring(data.transactions, data.nowMs)
      .filter((s) => !FEE_PATTERN.test(s.label))
      .map((s) => {
        const annual = Math.round(s.latestMinor * s.periodsPerYear);
        return {
          key: s.merchant,
          title: `Subscription: ${s.label}`,
          detail: `About ${money(annual, s.currency)}/yr — ${s.count} charges of ~${money(s.latestMinor, s.currency)}.`,
          value: money(annual, s.currency),
          dollarImpactMinor: annual,
          currency: s.currency,
          confidence: 0.5,
          effort: 1,
          evidence: { summary: `${s.count} recurring charges of ~${money(s.latestMinor, s.currency)}.`, records: s.recordIds },
          actionLabel: 'Cancel if you no longer use it',
          accountId: s.accountId,
          createdAt: s.lastDate,
        } satisfies Draft;
      })
      .filter((draft) => (draft.dollarImpactMinor ?? 0) >= 6_000)
      .sort((a, b) => (b.dollarImpactMinor ?? 0) - (a.dollarImpactMinor ?? 0))
      .slice(0, 15);
  },
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
  run(rule, data) {
    const current = new Map<string, number>();
    const baseline = new Map<string, number>();
    for (const txn of data.transactions) {
      if (txn.amountMinor >= 0) continue;
      const category = (txn.category || '').trim();
      if (!category || NON_DISCRETIONARY_CATEGORY.test(category)) continue;
      const ageDays = (data.nowMs - new Date(txn.date).getTime()) / 86_400_000;
      if (!Number.isFinite(ageDays) || ageDays < 0) continue;
      const amount = Math.abs(txn.amountMinor);
      if (ageDays <= 30) current.set(category, (current.get(category) ?? 0) + amount);
      else if (ageDays <= 120) baseline.set(category, (baseline.get(category) ?? 0) + amount);
    }
    const drafts: Draft[] = [];
    for (const [category, currentAmount] of current) {
      const avg = (baseline.get(category) ?? 0) / 3;
      const overage = currentAmount - avg;
      if (avg <= 0 || currentAmount < avg * 1.4 || overage < 5_000) continue;
      drafts.push({
        key: category,
        title: `${prettyCategory(category)} spending is up`,
        detail: `${money(currentAmount)} in the last 30 days vs about ${money(Math.round(avg))} in a typical month.`,
        value: `+${money(Math.round(overage))}`,
        dollarImpactMinor: Math.round(overage),
        confidence: 0.6,
        effort: 2,
        evidence: { summary: `Last 30 days ${money(currentAmount)} vs 3-month average ${money(Math.round(avg))}.`, records: [category] },
        actionLabel: 'Review this category',
        createdAt: new Date(data.nowMs).toISOString(),
      });
    }
    return drafts.sort((a, b) => (b.dollarImpactMinor ?? 0) - (a.dollarImpactMinor ?? 0)).slice(0, 5);
  },
};

// Spending: a recurring charge that only started recently — a new subscription or
// a free trial that has converted to paid. Relaxed recurring detection.
const newRecurringCharge: Evaluator = {
  kind: 'new-recurring-charge',
  domain: 'spending',
  executionClass: 'D',
  defaultTier: 'advisor',
  scope: 'banking',
  keywords: /new subscription|new recurring|free trial|trial|新订阅|试用/,
  run(rule, data) {
    return detectRecurring(data.transactions, data.nowMs, { minCount: 2, minSpanDays: 18 })
      .filter((s) => !FEE_PATTERN.test(s.label) && s.count <= 4)
      .filter((s) => (data.nowMs - new Date(s.firstDate).getTime()) / 86_400_000 <= 50)
      .map((s) => {
        const annual = Math.round(s.latestMinor * s.periodsPerYear);
        return {
          key: s.merchant,
          title: `New recurring charge: ${s.label}`,
          detail: `Recently started at ${money(s.latestMinor, s.currency)} — about ${money(annual, s.currency)}/yr if it continues.`,
          value: money(annual, s.currency),
          dollarImpactMinor: annual,
          currency: s.currency,
          confidence: 0.5,
          effort: 2,
          evidence: { summary: `First seen ${s.firstDate}, ${s.count} charges of ~${money(s.latestMinor, s.currency)}.`, records: s.recordIds },
          actionLabel: 'Confirm this is a subscription you want',
          accountId: s.accountId,
          createdAt: s.lastDate,
        } satisfies Draft;
      })
      .filter((draft) => (draft.dollarImpactMinor ?? 0) >= 6_000)
      .slice(0, 10);
  },
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
  run(rule, data) {
    const spendingBalances = data.balances.filter((balance) => {
      const account = data.accounts.find((a) => a.id === balance.accountId);
      return Boolean(account) && account!.domain !== 'brokerage' && !isCreditAccount(account);
    });
    // Without any spending-account balance we cannot know the cash on hand, so we
    // do not infer runway from nothing.
    if (spendingBalances.length === 0) return [];
    const liquid = spendingBalances.reduce((sum, balance) => sum + Math.max(0, balance.availableMinor ?? balance.currentMinor), 0);
    const windowStart = data.nowMs - 90 * 86_400_000;
    const outflow = data.transactions
      .filter((txn) => txn.amountMinor < 0 && new Date(txn.date).getTime() >= windowStart && !/transfer/i.test(txn.category || ''))
      .reduce((sum, txn) => sum + Math.abs(txn.amountMinor), 0);
    const monthly = outflow / 3;
    if (monthly <= 0) return [];
    const months = liquid / monthly;
    if (months >= 2) return [];
    return [{
      key: 'runway',
      title: 'Low cash runway',
      detail: `${money(liquid)} liquid against about ${money(Math.round(monthly))}/mo spending — roughly ${months.toFixed(1)} months.`,
      value: `${months.toFixed(1)} mo`,
      confidence: 0.7,
      severity: months < 1 ? 'high' as const : 'medium' as const,
      urgency: months < 1 ? 1.5 : 1,
      evidence: { summary: `Liquid ${money(liquid)} / monthly spend ${money(Math.round(monthly))}.`, records: [] },
      createdAt: new Date(data.nowMs).toISOString(),
    } satisfies Draft];
  },
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
  run(rule, data) {
    if (data.accounts.length === 0) return [];
    const times: number[] = [];
    for (const balance of data.balances) times.push(new Date(balance.asOfDate).getTime());
    for (const txn of data.transactions) times.push(new Date(txn.date).getTime());
    const newest = Math.max(...times.filter((t) => Number.isFinite(t)));
    if (!Number.isFinite(newest)) return [];
    const ageDays = Math.round((data.nowMs - newest) / 86_400_000);
    if (ageDays < 21) return [];
    return [{
      key: 'stale',
      title: 'Account data may be stale',
      detail: `Newest activity is about ${ageDays} days old. Resync your connections to refresh balances and transactions.`,
      value: `${ageDays}d`,
      confidence: 0.8,
      severity: 'medium' as const,
      evidence: { summary: `Most recent balance/transaction is ${ageDays} days old.`, records: [] },
      actionLabel: 'Resync connected accounts',
      createdAt: new Date(data.nowMs).toISOString(),
    } satisfies Draft];
  },
};

// Order matters for natural-language inference: the first evaluator whose
// keywords match wins, so specific evaluators precede the broad idle-cash and
// large-transaction fallbacks.
const EVALUATORS: Evaluator[] = [
  connectionHealth,
  staleData,
  creditUtilization,
  employerMatch,
  cashRunway,
  lowBalance,
  feesAndInterest,
  subscriptionPriceIncrease,
  newRecurringCharge,
  recurringSubscriptions,
  spendingCategorySpike,
  idleBrokerageCash,
  portfolioConcentration,
  duplicateCharge,
  idleCash,
  largeTransaction,
];

const REGISTRY = new Map<string, Evaluator>(EVALUATORS.map((e) => [e.kind, e]));

// ── Interpreter ──────────────────────────────────────────────────────────────

function finalize(rule: RuleRecord, evaluator: Evaluator, draft: Draft): Finding {
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
    domain: evaluator.domain,
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

// A synthetic rule for always-on evaluators that have no stored rule.
function builtinRule(evaluator: Evaluator, nowIso: string): RuleRecord {
  return {
    id: '',
    kind: evaluator.kind,
    domain: evaluator.domain,
    sourceText: `Built-in ${evaluator.kind}`,
    executionClass: evaluator.executionClass,
    actionTier: evaluator.defaultTier,
    scope: evaluator.scope,
    cadence: 'event',
    channel: 'auto',
    scheduledHour: null,
    scheduledDay: null,
    enabled: true,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

// Evaluate enabled rules plus any always-on evaluator not already covered by a
// stored rule. A rule blocked on a missing required fact yields questions instead
// of findings, ranked by the dollars the answer would unlock. Findings below the
// suppression floor are dropped unless they are explicit high-severity safety
// findings. The caller applies mutes and delivery on top of this.
export function evaluateRules(rules: RuleRecord[], data: EvaluationData): EngineResult {
  const findings: Finding[] = [];
  const questions = new Map<string, QuestionDraft>();
  const enabled = rules.filter((rule) => rule.enabled);
  const covered = new Set(enabled.map((rule) => rule.kind));
  const nowIso = new Date(data.nowMs).toISOString();

  const runnable: RuleRecord[] = [
    ...enabled,
    ...EVALUATORS.filter((e) => e.alwaysOn && !covered.has(e.kind)).map((e) => builtinRule(e, nowIso)),
  ];

  for (const rule of runnable) {
    const evaluator = REGISTRY.get(rule.kind);
    if (!evaluator) continue;
    const missing = (evaluator.facts ?? []).filter((need) => !data.facts.has(need.key));
    if (missing.length > 0) {
      for (const need of missing) {
        questions.set(need.key, {
          factKey: need.key,
          prompt: need.prompt,
          ruleKind: rule.kind,
          unlockImpactMinor: need.unlockImpactMinor,
          currency: need.currency ?? 'USD',
          suggestedValue: need.suggest ? need.suggest(data) : null,
        });
      }
      continue; // blocked on a fact — produces a question, not a finding
    }
    for (const draft of evaluator.run(rule, data)) {
      const finding = finalize(rule, evaluator, draft);
      // Suppress only low-severity findings that also fall below the dollar floor.
      // An evaluator that explicitly asserts medium/high severity (a risk with no
      // dollar value, e.g. utilization or concentration) always surfaces.
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

export function inferRule(text: string, scope?: string, cadence?: string): InferredRule {
  const lower = text.toLowerCase();
  const evaluator = EVALUATORS.find((e) => e.keywords.test(lower)) ?? largeTransaction;
  const chosenScope = (scope && SCOPES.includes(scope) ? scope : evaluator.scope);
  const chosenCadence = (cadence && CADENCES.includes(cadence) ? cadence : inferCadence(lower));
  return {
    kind: evaluator.kind,
    domain: evaluator.domain,
    executionClass: evaluator.executionClass,
    actionTier: evaluator.defaultTier,
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
