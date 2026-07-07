export interface Account {
  id: string;
  institution: string;
  name: string;
  type: string;
  currency: string;
  domain: string;
  source: string;
  providerAccountId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  sourceId: string | null;
  date: string;
  description: string;
  amountMinor: number;
  currency: string;
  category: string | null;
  pending: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TransactionInput {
  sourceId?: string | null;
  date: string;
  description: string;
  amountMinor: number;
  category?: string | null;
  pending?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ImportRecord {
  id: string;
  accountId: string;
  filename: string;
  format: string;
  contentHash: string;
  insertedCount: number;
  skippedCount: number;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MoneySummary {
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

export interface ProviderConnection {
  id: string;
  provider: string;
  externalId: string;
  institution: string | null;
  status: string;
  environment: string | null;
  hasAccessToken: boolean;
  hasCursor: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerageTransaction {
  id: string;
  accountId: string;
  sourceId: string | null;
  date: string;
  description: string;
  amountMinor: number;
  currency: string;
  symbol: string | null;
  investmentType: string | null;
  quantity: string | null;
  priceMinor: number | null;
  category: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface BrokerageHolding {
  id: string;
  accountId: string;
  asOfDate: string;
  securityId: string | null;
  symbol: string | null;
  name: string | null;
  securityType: string | null;
  quantity: string | null;
  costBasisMinor: number | null;
  priceMinor: number | null;
  valueMinor: number;
  currency: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AccountBalance {
  id: string;
  accountId: string;
  asOfDate: string;
  currentMinor: number;
  availableMinor: number | null;
  limitMinor: number | null;
  cashMinor: number | null;
  buyingPowerMinor: number | null;
  currency: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface BrokerageSummary {
  currency: string;
  marketValueMinor: number;
  cashMinor: number;
  buyingPowerMinor: number;
  holdings: number;
  transactions: number;
}

export interface DashboardRecord {
  id: string;
  publicId: string | null;
  name: string;
  layout: unknown;
  artifacts: ChartArtifact[];
  createdAt: string;
  updatedAt: string;
}

export interface ChartArtifact {
  id: string;
  publicId: string | null;
  name: string;
  artifact: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettingPreview {
  key: string;
  set: boolean;
  preview: string;
  secret: boolean;
  updatedAt: string | null;
}

export interface CreditReportRecord {
  id: string;
  filename: string;
  contentHash: string;
  bureau: string | null;
  reportDate: string | null;
  score: number | null;
  scoreModel: string | null;
  utilizationPercent: number | null;
  totalBalanceMinor: number | null;
  totalLimitMinor: number | null;
  accounts: number;
  openAccounts: number;
  delinquentAccounts: number;
  collections: number;
  inquiries: number;
  publicRecords: number;
  raw: Record<string, unknown>;
  bytes: number;
  createdAt: string;
}

// ── Rules engine ─────────────────────────────────────────────────────────────
// The full design lives in docs/rules-design.md. Rules are stored as normalized
// metadata and interpreted by a detector registry; every evaluator, regardless of
// execution class, emits the same Finding contract.

// The capability a rule's condition requires, decided by one question: can the
// truth of this rule be expressed as exact logic over structured data we already
// hold? Yes -> D. No, it needs meaning or judgment -> L / L+. Where a rule
// physically runs (local model, remote model, query engine) is a separate routing
// concern and does not appear here.
export type RuleExecutionClass = 'D' | 'L' | 'L+';

// How far a rule may act on a finding, subject to the user's grant. Detection is
// always read-only; anything past Observer is opt-in and revocable, and a rule's
// tier is additionally capped by finding confidence at run time.
export type RuleActionTier = 'observer' | 'advisor' | 'guardian' | 'navigator';

export type RuleDomain = 'cash-flow' | 'spending' | 'credit' | 'investments' | 'connections';

export interface RuleRecord {
  id: string;
  kind: string; // evaluator key in the detector registry
  domain: RuleDomain;
  sourceText: string;
  executionClass: RuleExecutionClass;
  actionTier: RuleActionTier;
  scope: string;
  cadence: string;
  channel: string;
  scheduledHour: number | null;
  // Which day the rule's schedule targets: weekday 0=Sunday..6 for weekly, day of
  // month 1..28 for monthly, null otherwise. Descriptive schedule metadata.
  scheduledDay: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// A user fact a rule depends on; a missing one becomes a ranked question.
// `expects` hints the value shape so input can be normalized and validated (by the
// model when available, deterministically otherwise) before it is stored as a fact.
export type FactExpectation = 'currency' | 'percent' | 'number' | 'date' | 'text';

export interface RuleFactNeed {
  key: string;
  prompt: string;
  unlockImpactMinor: number;
  currency?: string | undefined;
  expects?: FactExpectation | undefined;
}

// A rule definition as DATA (see docs/rules-design.md). Built-in specs ship as a
// seed and download-delivered specs are upserted into the rule_specs table; the
// engine interprets both uniformly. A spec carries EITHER sql (deterministic) or
// prompt (LLM). keywords is a regex source string for natural-language inference.
export interface RuleSpec {
  kind: string;
  domain: RuleDomain;
  executionClass: RuleExecutionClass;
  actionTier: RuleActionTier;
  scope: string;
  cadence: string;
  alwaysOn: boolean;
  keywords: string;
  sql: string | null;
  prompt: string | null;
  facts: RuleFactNeed[];
  enabled: boolean;
  source: string; // builtin | downloaded | user
  version: number;
}

// A single actionable finding, uniform across every evaluator. dollarImpactMinor
// is signed integer minor units normalized to a twelve-month horizon so findings
// are comparable; confidence is 0..1; score is the computed ranking value.
export interface Finding {
  id: string;
  ruleId: string | null;
  kind: string;
  domain: RuleDomain;
  scope: string;
  title: string;
  detail: string;
  value: string;
  dollarImpactMinor: number;
  currency: string;
  confidence: number;
  urgency: number; // >= 1 multiplier; 1 means no deadline pressure
  effort: number; // >= 1 divisor; 1 means one tap
  score: number; // |dollarImpactMinor| * confidence * urgency / effort
  severity: 'high' | 'medium' | 'low'; // derived from score, kept for display
  actionTier: RuleActionTier;
  action: FindingAction | null;
  evidence: FindingEvidence;
  accountId?: string;
  createdAt: string;
}

export interface FindingAction {
  tier: RuleActionTier; // the tier this action would run at, after confidence capping
  label: string;
  artifact: string | null; // generated text for the Advisor tier; null until produced
}

export interface FindingEvidence {
  summary: string; // deterministic explanation of why the finding fired
  records: string[]; // ids of the records that produced it
}

// A value the user knows but the account stream does not expose. A required fact
// with no value turns into a Question rather than failing the rule. User-entered
// facts carry lower confidence than stream-derived ones, and that difference
// propagates into finding confidence.
export interface FactRecord {
  key: string;
  value: string;
  source: 'user' | 'derived' | 'reference';
  confidence: number;
  refreshAfter: string | null; // ISO date; prompt to re-verify past this point
  updatedAt: string;
}

// A pending question whose answer unlocks one or more rules, ranked by the dollar
// impact it would unlock. suggestedValue supports derive-then-confirm.
export interface QuestionRecord {
  id: string;
  factKey: string;
  prompt: string;
  ruleKind: string;
  unlockImpactMinor: number;
  currency: string;
  suggestedValue: string | null;
  status: 'pending' | 'answered' | 'dismissed';
  createdAt: string;
  updatedAt: string;
}

export interface FindingMuteRecord {
  id: string;
  kind: string | null;
  accountId: string | null;
  label: string | null;
  expiresAt: string | null;
  createdAt: string;
}

// Append-only record of a single step in an agent interaction (a chat turn, a
// tool call, a tool result). This log is the substrate the reflection job reads
// to distill durable facts into the user profile.
export type AgentEventType = 'user_message' | 'assistant_message' | 'tool_call' | 'tool_result';

export interface AgentEventRecord {
  id: string;
  turnId: string;
  eventType: AgentEventType;
  role: string | null;
  toolName: string | null;
  content: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

// A durable conversation for an inbound chat channel (e.g. a Telegram DM). The
// key identifies the peer/channel; sessionId is the current conversation
// instance and rotates whenever the session resets (explicit /reset or the daily
// rollover). Persisting this lets a conversation survive backend restarts and
// gives the reset policy a stable startedAt to key off.
export interface ChatSessionRecord {
  sessionKey: string;
  sessionId: string;
  startedAt: string;
  lastInteractionAt: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}
