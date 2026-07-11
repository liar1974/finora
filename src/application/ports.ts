import type {
  Account,
  AccountBalance,
  AgentEventRecord,
  AgentEventType,
  AppSettingPreview,
  BrokerageHolding,
  BrokerageSummary,
  BrokerageValuePoint,
  BrokerageTransaction,
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
  RuleDomain,
  RuleRecord,
  RuleSpec,
  RuleSqlDraft,
  Transaction,
  TransactionInput,
} from '../domain/models.js';

// The user-owned fields set when a rule is adopted or edited. Cadence is a
// delivery-scheduling preference the user picks, so it lives here (and is
// preserved across definition re-seeding), not with the definition columns.
export interface RuleAdoption {
  sourceText: string;
  cadence: string;
  channel: string;
  scheduledHour: number | null;
  scheduledDay: number | null;
}

// The definition columns rewritten when a user edits a custom rule's content. The
// natural-language sourceText is kept alongside the regenerated SQL so the next
// edit can pre-fill it.
export interface RuleContentEdit {
  sql: string;
  keywords: string;
  domain: RuleDomain;
  scope: string;
  sourceText: string;
}

export interface AgentEventInput {
  turnId: string;
  eventType: AgentEventType;
  role?: string | null;
  toolName?: string | null;
  content?: string | null;
  payload?: Record<string, unknown> | undefined;
}

export interface AccountCreate {
  institution: string;
  name: string;
  type: string;
  currency: string;
  domain?: string | undefined;
  source?: string | undefined;
  providerAccountId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ProviderConnectionSave {
  provider: string;
  externalId: string;
  institution?: string | null;
  status?: string | undefined;
  environment?: string | null | undefined;
  accessToken?: string | null | undefined;
  cursor?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface TransactionQuery {
  accountId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

export interface SummaryQuery {
  accountId?: string;
  from?: string;
  to?: string;
}

export interface SaveImportInput {
  account: Account;
  filename: string;
  format: string;
  contentHash: string;
  transactions: Array<TransactionInput & { fingerprint: string }>;
}

export interface ProviderTransactionInput extends TransactionInput {
  accountId: string;
  currency: string;
  fingerprint: string;
  // When set, an existing row with this fingerprint (the pending charge) is
  // updated in place to the posted values instead of inserting a new row, so
  // the stable row id survives the Plaid pending→posted transition.
  supersedesFingerprint?: string | null;
}

export interface ProviderBrokerageTransactionInput {
  accountId: string;
  sourceId?: string | null;
  date: string;
  description: string;
  amountMinor: number;
  currency: string;
  symbol?: string | null;
  investmentType?: string | null;
  quantity?: string | null;
  priceMinor?: number | null;
  category?: string | null;
  metadata?: Record<string, unknown> | undefined;
  fingerprint: string;
}

export interface ProviderHoldingInput {
  accountId: string;
  asOfDate: string;
  securityId?: string | null;
  symbol?: string | null;
  name?: string | null;
  securityType?: string | null;
  quantity?: string | null;
  costBasisMinor?: number | null;
  priceMinor?: number | null;
  valueMinor: number;
  currency: string;
  metadata?: Record<string, unknown> | undefined;
  fingerprint: string;
}

export interface ProviderBalanceInput {
  accountId: string;
  asOfDate: string;
  currentMinor: number;
  availableMinor?: number | null;
  limitMinor?: number | null;
  cashMinor?: number | null;
  buyingPowerMinor?: number | null;
  currency: string;
  metadata?: Record<string, unknown> | undefined;
  fingerprint: string;
}

export interface FinanceRepository {
  createAccount(input: AccountCreate): Account;
  listAccounts(): Account[];
  getAccount(id: string): Account | null;
  removeAccount(id: string): boolean;
  listTransactions(query: TransactionQuery): Page<Transaction>;
  summarize(query: SummaryQuery): MoneySummary[];
  listProviderConnections(): ProviderConnection[];
  getProviderConnectionSecret(provider: string, externalId: string): { accessToken: string | null; cursor: string | null; metadata: Record<string, unknown> } | null;
  saveProviderConnection(input: ProviderConnectionSave): ProviderConnection;
  listBrokerageTransactions(query: TransactionQuery): Page<BrokerageTransaction>;
  listBrokerageHoldings(accountId?: string): BrokerageHolding[];
  runRuleQuery(sql: string, params: Record<string, unknown>): Record<string, unknown>[];
  listAccountBalances(accountId?: string): AccountBalance[];
  summarizeBrokerage(): BrokerageSummary[];
  brokerageValueSeries(accountId?: string): BrokerageValuePoint[];
  listDashboards(): DashboardRecord[];
  listCreditReports(): CreditReportRecord[];
  saveCreditReport(input: Omit<CreditReportRecord, 'id' | 'createdAt'>): CreditReportRecord;
  removeCreditReport(id: string): boolean;
  listAppSettings(keys?: string[]): AppSettingPreview[];
  getAppSetting(key: string): string | null;
  saveAppSettings(entries: Record<string, string>): void;
  listRules(): RuleRecord[];
  // Turn a rule on (by kind) with the user's schedule/channel: sets active=1.
  // Returns null when no rule with that kind exists.
  adoptRule(kind: string, schedule: RuleAdoption): RuleRecord | null;
  toggleRule(kind: string, active: boolean): RuleRecord | null;
  updateRuleSchedule(kind: string, schedule: { cadence: string; scheduledHour: number | null; scheduledDay: number | null }): RuleRecord | null;
  // Read one rule by kind (for source-based permission checks). Null if absent.
  getRule(kind: string): RuleRecord | null;
  // Insert a user-authored custom rule (source = 'user'), active by default.
  createUserRule(spec: RuleSpec, schedule: RuleAdoption): RuleRecord;
  // Rewrite a custom rule's definition (its LLM-authored SQL and classification).
  // Guarded to source = 'user'; returns null when no such custom rule exists.
  updateUserRuleContent(kind: string, content: RuleContentEdit): RuleRecord | null;
  // Delete a custom rule. Guarded to source = 'user'; returns false otherwise.
  deleteRule(kind: string): boolean;
  listRuleSpecs(): RuleSpec[];
  upsertRuleSpec(spec: RuleSpec): void;
  listRecurringCandidates(): RecurringCandidate[];
  listTransactionsByIds(ids: string[]): Transaction[];
  listRecurringClassifications(): RecurringClassification[];
  upsertRecurringClassification(row: RecurringClassification): void;
  listMerchantCandidates(): MerchantCandidate[];
  listMerchantIdentities(): MerchantIdentity[];
  upsertMerchantIdentity(row: MerchantIdentity): void;
  listFindingMutes(): FindingMuteRecord[];
  saveFindingMute(input: Omit<FindingMuteRecord, 'id' | 'createdAt'>): FindingMuteRecord;
  removeFindingMute(id: string): boolean;
  listFacts(): FactRecord[];
  getFact(key: string): FactRecord | null;
  upsertFact(input: Omit<FactRecord, 'updatedAt'>): FactRecord;
  removeFact(key: string): boolean;
  listQuestions(status?: QuestionRecord['status']): QuestionRecord[];
  upsertQuestion(input: Omit<QuestionRecord, 'id' | 'createdAt' | 'updatedAt'>): QuestionRecord;
  updateQuestionStatus(id: string, status: QuestionRecord['status']): boolean;
  findImport(accountId: string, contentHash: string): ImportRecord | null;
  saveImport(input: SaveImportInput): ImportRecord;
  reconcileProviderTransactions(transactions: ProviderTransactionInput[]): { inserted: number; updated: number; skipped: number };
  deleteTransactionsByFingerprints(accountId: string, fingerprints: string[]): number;
  saveProviderBrokerageTransactions(transactions: ProviderBrokerageTransactionInput[]): { inserted: number; skipped: number };
  saveProviderHoldings(holdings: ProviderHoldingInput[]): { inserted: number; skipped: number };
  saveProviderBalances(balances: ProviderBalanceInput[]): { inserted: number; skipped: number };
  setBrokerageCashMinor(accountId: string, asOfDate: string, cashMinor: number): void;
  getUserProfileMarkdown(): string | null;
  saveUserProfileMarkdown(markdown: string): void;
  appendAgentEvent(input: AgentEventInput): void;
  listAgentEventsSince(since: string | null, until: string): AgentEventRecord[];
  getReflectionCursor(): string | null;
  setReflectionCursor(at: string): void;
  getChatSession(sessionKey: string): ChatSessionRecord | null;
  saveChatSession(record: ChatSessionRecord): void;
  close(): void;
}

export interface ParseContext {
  currency: string;
  filename: string;
}

export interface StatementParser {
  readonly format: string;
  supports(filename: string, content: Uint8Array): boolean;
  parse(content: Uint8Array, context: ParseContext): TransactionInput[];
}

// Fetches the raw rule-feed document from a configured URL (long-term a GitHub raw
// URL). Kept behind a port so the network call is injectable — tests supply a stub
// feed, dev points it at a local static server, prod at GitHub. The service parses,
// validates, and upserts; the client only transports bytes.
export interface RuleFeedClient {
  fetchFeed(url: string): Promise<string>;
}

// The verdict a classifier returns for one candidate series — the stored
// classification minus the bookkeeping columns the service fills in.
export type RecurringVerdict = Omit<RecurringClassification, 'signature' | 'updatedAt'>;

// Turns deterministic candidate series into recurrence verdicts. The production
// implementation calls the configured LLM; tests inject a deterministic stub so
// the classifier seam is exercised without a model. Injecting one also stands in
// for "a model is available".
export type RecurringClassifier = (candidates: RecurringCandidate[]) => Promise<RecurringVerdict[]>;

// The verdict the merchant identifier returns for one candidate — the stored
// identity minus the bookkeeping columns the service fills in.
export type MerchantIdentityVerdict = Omit<MerchantIdentity, 'signature' | 'updatedAt'>;

// Resolves normalized merchants to canonical vendor identities. Production calls
// the configured LLM (world knowledge of brands); tests inject a deterministic
// stub, which also stands in for "a model is available".
export type MerchantIdentifier = (candidates: MerchantCandidate[]) => Promise<MerchantIdentityVerdict[]>;

// Turns a user's natural-language rule description into a deterministic SQL
// definition. Production calls the configured LLM with the readable schema and the
// required finding-draft output columns; tests inject a deterministic stub (which
// also stands in for "a model is available"). The service validates and persists.
export type RuleSqlAuthor = (input: { text: string }) => Promise<RuleSqlDraft>;
