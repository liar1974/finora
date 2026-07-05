import type {
  Account,
  AccountBalance,
  AlertMuteRecord,
  AlertRuleRecord,
  AppSettingPreview,
  BrokerageHolding,
  BrokerageSummary,
  BrokerageTransaction,
  CreditReportRecord,
  DashboardRecord,
  ImportRecord,
  MoneySummary,
  Page,
  ProviderConnection,
  Transaction,
  TransactionInput,
} from '../domain/models.js';

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
  listAccountBalances(accountId?: string): AccountBalance[];
  summarizeBrokerage(): BrokerageSummary[];
  listDashboards(): DashboardRecord[];
  listCreditReports(): CreditReportRecord[];
  saveCreditReport(input: Omit<CreditReportRecord, 'id' | 'createdAt'>): CreditReportRecord;
  removeCreditReport(id: string): boolean;
  listAppSettings(keys?: string[]): AppSettingPreview[];
  getAppSetting(key: string): string | null;
  saveAppSettings(entries: Record<string, string>): void;
  listAlertRules(): AlertRuleRecord[];
  saveAlertRule(input: Omit<AlertRuleRecord, 'id' | 'createdAt' | 'updatedAt'>): AlertRuleRecord;
  toggleAlertRule(id: string, enabled: boolean): AlertRuleRecord | null;
  removeAlertRule(id: string): boolean;
  listAlertMutes(): AlertMuteRecord[];
  saveAlertMute(input: Omit<AlertMuteRecord, 'id' | 'createdAt'>): AlertMuteRecord;
  removeAlertMute(id: string): boolean;
  findImport(accountId: string, contentHash: string): ImportRecord | null;
  saveImport(input: SaveImportInput): ImportRecord;
  saveProviderTransactions(transactions: ProviderTransactionInput[]): { inserted: number; skipped: number };
  reconcileProviderTransactions(transactions: ProviderTransactionInput[]): { inserted: number; updated: number; skipped: number };
  deleteTransactionsByFingerprints(accountId: string, fingerprints: string[]): number;
  saveProviderBrokerageTransactions(transactions: ProviderBrokerageTransactionInput[]): { inserted: number; skipped: number };
  saveProviderHoldings(holdings: ProviderHoldingInput[]): { inserted: number; skipped: number };
  saveProviderBalances(balances: ProviderBalanceInput[]): { inserted: number; skipped: number };
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
