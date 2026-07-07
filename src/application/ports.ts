import type {
  Account,
  AccountBalance,
  AgentEventRecord,
  AgentEventType,
  AppSettingPreview,
  BrokerageHolding,
  BrokerageSummary,
  BrokerageTransaction,
  ChatSessionRecord,
  CreditReportRecord,
  DashboardRecord,
  FactRecord,
  FindingMuteRecord,
  ImportRecord,
  MoneySummary,
  Page,
  ProviderConnection,
  QuestionRecord,
  RuleRecord,
  RuleSpec,
  Transaction,
  TransactionInput,
} from '../domain/models.js';

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
  listDashboards(): DashboardRecord[];
  listCreditReports(): CreditReportRecord[];
  saveCreditReport(input: Omit<CreditReportRecord, 'id' | 'createdAt'>): CreditReportRecord;
  removeCreditReport(id: string): boolean;
  listAppSettings(keys?: string[]): AppSettingPreview[];
  getAppSetting(key: string): string | null;
  saveAppSettings(entries: Record<string, string>): void;
  listRules(): RuleRecord[];
  saveRule(input: Omit<RuleRecord, 'id' | 'createdAt' | 'updatedAt'>): RuleRecord;
  toggleRule(id: string, enabled: boolean): RuleRecord | null;
  removeRule(id: string): boolean;
  listRuleSpecs(): RuleSpec[];
  upsertRuleSpec(spec: RuleSpec): void;
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
