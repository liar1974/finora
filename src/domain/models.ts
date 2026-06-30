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

export interface AlertRuleRecord {
  id: string;
  kind: string;
  sourceText: string;
  scope: string;
  cadence: string;
  channel: string;
  scheduledHour: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertMuteRecord {
  id: string;
  kind: string | null;
  accountId: string | null;
  label: string | null;
  expiresAt: string | null;
  createdAt: string;
}
