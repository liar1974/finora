import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from 'plaid';
import { Snaptrade } from 'snaptrade-typescript-sdk';
import { AppError, asAppError } from './errors.js';
import type {
  AccountCreate,
  AgentEventInput,
  FinanceRepository,
  ProviderBalanceInput,
  ProviderBrokerageTransactionInput,
  ProviderHoldingInput,
  ProviderTransactionInput,
  MerchantIdentifier,
  MerchantIdentityVerdict,
  RecurringClassifier,
  RecurringVerdict,
  RuleFeedClient,
  RuleSqlAuthor,
  StatementParser,
  SummaryQuery,
  TransactionQuery,
} from './ports.js';
import {
  DEFAULT_PROFILE,
  MEMORY_POLICY,
  REFLECTION_SYSTEM_PROMPT,
  applyRemember,
  extractMarkdown,
  memoryContext,
  normalizeProfileMarkdown,
  profileIsEmpty,
  sectionFromKind,
  type MemorySection,
} from './memory.js';
import {
  assertIsoDate,
  assertMinorAmount,
  normalizeCurrency,
  requireText,
} from '../domain/invariants.js';
import type { Account, ChatSessionRecord, CreditReportRecord, FactExpectation, Finding, ImportRecord, MerchantCandidate, RecurringCandidate, RecurringClassification, RecurringDirection, RuleDomain, RuleFactNeed, RuleSpec, RuleSqlDraft, Transaction, TransactionInput } from '../domain/models.js';
import { builtinRuleSpecs, evaluateRules, executionStrategy, inferRule } from './rules-engine.js';
import type { EvaluationData, QuestionDraft } from './rules-engine.js';
import { clampChatInput, generateChatReply, LLM_PROVIDERS, providerContextTokens, resolveLlmConfig } from '../infrastructure/llm-gateway.js';
import { getBuiltinModel, LocalModelEngine, ModelNotDownloadedError } from '../infrastructure/local-model.js';
import { TelegramGateway, sendTelegramMessage } from '../infrastructure/telegram-gateway.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The most recent daily reset boundary at or before `now` (default 04:00 local).
 * A chat session that started before this boundary has crossed the daily
 * rollover and is replaced with a fresh one on the next message.
 */
export function dailyResetBoundary(now: Date, hour = 4): Date {
  const boundary = new Date(now);
  boundary.setHours(hour, 0, 0, 0);
  if (boundary.getTime() > now.getTime()) boundary.setDate(boundary.getDate() - 1);
  return boundary;
}

export interface ChatContextAttachment {
  id: string;
  type: 'chart' | 'table' | 'item';
  title: string;
  section?: string | undefined;
  totalRows?: number | undefined;
  columns?: string[] | undefined;
  rows?: Record<string, string | number | boolean | null>[] | undefined;
  artifact?: unknown;
  note?: string | undefined;
}

export interface ImportStatementInput {
  accountId: string;
  filename: string;
  content: Uint8Array;
  format?: string;
}

interface ProviderSyncResult {
  accounts: number;
  transactions: number;
  balances: number;
  holdings: number;
  modified: number;
  removed: number;
  skipped: number;
  errors: number;
}

interface CreditTradeline {
  creditor: string;
  accountMask: string | null;
  accountType: string | null;
  status: string | null;
  isOpen: boolean;
  isNegative: boolean;
  isRevolving: boolean;
  dateOpened: string | null;
  dateReported: string | null;
  balanceMinor: number | null;
  creditLimitMinor: number | null;
  pastDueMinor: number | null;
}

interface CreditInquiry {
  company: string;
  inquiryDate: string | null;
  type: 'hard' | 'soft';
}

interface CreditDisputeSuggestion {
  severity: 'high' | 'medium' | 'low';
  issue: string;
  creditor: string;
  accountMask: string | null;
  why: string;
  fcra: string;
  reason: string;
}

interface CreditExtraction {
  bureau: string | null;
  reportDate: string | null;
  score: number | null;
  scoreModel: string | null;
  accounts: CreditTradeline[];
  inquiries: CreditInquiry[];
  suggestions: CreditDisputeSuggestion[];
  textSample: string;
  // Full normalized report text, kept in-memory for LLM enrichment/grounding only.
  // Not persisted (importCreditReport stores textSample, not this).
  text: string;
}

export interface CreditAiReview {
  provider: string;
  model: string;
  addedAccounts: number;
  addedInquiries: number;
  ranAt: string;
}

export interface RecurringTransaction {
  id: string;
  date: string;
  description: string;
  amountMinor: number;
  currency: string;
  accountId: string;
}

// One row of the Recurring table, after LLM classification. A row is one payee
// (canonical name), merged across the possibly-many raw descriptions the payee
// bills under, with every underlying transaction attached for drill-down.
export interface RecurringListItem {
  merchant: string; // canonical display name
  direction: RecurringDirection;
  kind: string | null;
  cadence: string | null;
  category: string | null;
  count: number; // number of transactions in the merged series
  amountMinor: number; // typical (median) per-charge amount
  annualMinor: number; // typical amount annualized by cadence
  currency: string;
  firstDate: string;
  lastDate: string;
  confidence: number;
  transactions: RecurringTransaction[]; // all charges, most recent first
}

// ── Advisor artifacts (the "Fight" layer) ──────────────────────────────────────
// A finding's Observer tier surfaces the problem; the Advisor tier drafts a
// document that helps the user act on it — a dispute letter, a fee-waiver
// request, a negotiation script. The detection stays deterministic (an existing
// D rule) and the money math is already computed; the model only turns the
// finding's own facts into prose. It NEVER invents a number, date, or account
// detail not present in the grounding JSON, and Finora never sends the document
// — it drafts for the user to review and send themselves, so the read-only
// promise holds. This mirrors the deterministic credit dispute-letter template.
const ARTIFACT_DRAFTER_PREAMBLE = [
  'You draft one short, ready-to-use document for a Finora user to review and send THEMSELVES.',
  "Finora never sends anything on the user's behalf; write in the user's first-person voice.",
  'Ground every amount, date, and merchant STRICTLY in the provided JSON. Never invent figures, account numbers, policy numbers, or facts that are not present.',
  'Use [Your name], [Your address], [Account number] placeholders where personal details are needed.',
  'Output ONLY the finished document text — no explanation, no preamble, no markdown code fences.',
].join('\n');

interface ArtifactSpec {
  artifactType: string; // stable id surfaced on the finding and returned to the client
  title: string; // human label for the drafted document
  system: string; // the drafter instruction, prepended with ARTIFACT_DRAFTER_PREAMBLE
}

// Keyed by rule kind. Only rules whose D detector already exists appear here, so
// adding a drafter is data, not new detection. The set is the "Fight" batch
// (#8–#12 of the plan): duplicate charge, fees/interest, card interest,
// subscription price increase, recurring subscription, newly converted trial.
const ARTIFACT_SPECS: Record<string, ArtifactSpec> = {
  'duplicate-charge': {
    artifactType: 'dispute-letter',
    title: 'Dispute letter',
    system: [
      ARTIFACT_DRAFTER_PREAMBLE,
      'Write a concise dispute letter to the card issuer or bank contesting a duplicate charge.',
      'State the merchant, both charge dates, and the amount, and request that the duplicate be reversed.',
      'Reference the cardholder\'s right to dispute a billing error.',
    ].join('\n'),
  },
  'cross-account-duplicate': {
    artifactType: 'dispute-letter',
    title: 'Dispute letter',
    system: [
      ARTIFACT_DRAFTER_PREAMBLE,
      'Write a concise letter to the bank or card issuer about the same vendor and amount being paid from two different accounts.',
      'State the vendor, both charge dates, and the amount, and request a reversal of the duplicate payment.',
    ].join('\n'),
  },
  'fees-and-interest': {
    artifactType: 'fee-waiver-request',
    title: 'Fee-waiver request',
    system: [
      ARTIFACT_DRAFTER_PREAMBLE,
      'Write a polite message to the bank requesting a waiver or courtesy refund of the listed fees or interest charges.',
      'Cite the specific fee amounts and dates, note the account is otherwise in good standing, and ask for the refund.',
    ].join('\n'),
  },
  'card-interest': {
    artifactType: 'apr-reduction-request',
    title: 'APR-reduction script',
    system: [
      ARTIFACT_DRAFTER_PREAMBLE,
      'Write a brief phone or chat script asking the card issuer to lower the APR, referencing the interest recently paid.',
      'Keep it to a few spoken lines the user can read aloud.',
    ].join('\n'),
  },
  'subscription-price-increase': {
    artifactType: 'retention-script',
    title: 'Negotiation script',
    system: [
      ARTIFACT_DRAFTER_PREAMBLE,
      'Write a short phone or chat retention script pushing back on a subscription price increase.',
      'Reference the previous vs new amount, ask to keep the prior rate or a retention offer, and end with a polite cancel-if-not fallback.',
    ].join('\n'),
  },
};

// SnapTrade sync is intentionally off: it duplicated transactions for accounts also
// imported elsewhere, inflating realized P&L. Flip to true to re-enable once
// cross-provider transaction de-duplication exists.
const SNAPTRADE_SYNC_ENABLED = false;

export class FinanceService {
  private readonly telegramGateway: TelegramGateway;
  private backgroundServicesStarted = false;
  private alertKick: ReturnType<typeof setTimeout> | undefined;
  private alertTimer: ReturnType<typeof setInterval> | undefined;
  private providerSyncKick: ReturnType<typeof setTimeout> | undefined;
  private providerSyncTimer: ReturnType<typeof setInterval> | undefined;
  private providerSyncInFlight: Promise<unknown> | null = null;
  private reflectionKick: ReturnType<typeof setTimeout> | undefined;
  private reflectionTimer: ReturnType<typeof setInterval> | undefined;
  private ruleFeedKick: ReturnType<typeof setTimeout> | undefined;
  private ruleFeedTimer: ReturnType<typeof setInterval> | undefined;

  // When a classifier is injected (tests), it also stands in for "a model is
  // available"; otherwise the built-in LLM path is used and availability is
  // resolved from the configured provider.
  private readonly recurringClassifier: RecurringClassifier;
  private readonly recurringClassifierInjected: boolean;
  private readonly merchantIdentifier: MerchantIdentifier;
  private readonly merchantIdentifierInjected: boolean;
  private readonly ruleSqlAuthor: RuleSqlAuthor;

  constructor(
    private readonly repository: FinanceRepository,
    private readonly parsers: readonly StatementParser[],
    private readonly localModel: LocalModelEngine,
    private readonly ruleFeed?: RuleFeedClient,
    recurringClassifier?: RecurringClassifier,
    merchantIdentifier?: MerchantIdentifier,
    ruleSqlAuthor?: RuleSqlAuthor,
  ) {
    this.recurringClassifierInjected = Boolean(recurringClassifier);
    this.recurringClassifier = recurringClassifier ?? ((candidates) => this.classifyRecurringWithModel(candidates));
    this.merchantIdentifierInjected = Boolean(merchantIdentifier);
    this.merchantIdentifier = merchantIdentifier ?? ((candidates) => this.identifyMerchantsWithModel(candidates));
    this.ruleSqlAuthor = ruleSqlAuthor ?? ((input) => this.authorRuleSqlWithModel(input));
    this.telegramGateway = new TelegramGateway({
      getToken: () => this.telegramToken(),
      getChatId: () => this.repository.getAppSetting('TELEGRAM_CHAT_ID'),
      getLastUpdateId: () => Number(this.repository.getAppSetting('TELEGRAM_LAST_UPDATE_ID') || -1),
      saveLastUpdateId: (updateId) => {
        this.repository.saveAppSettings({ TELEGRAM_LAST_UPDATE_ID: String(updateId) });
      },
      onMessage: (text) => this.replyToTelegram(text),
    });
    // Seed built-in rule specs (data) into the table. Idempotent; downloaded and
    // user specs (other kinds) are untouched, so new rules stay pure data.
    for (const spec of builtinRuleSpecs()) this.repository.upsertRuleSpec(spec);
  }

  createAccount(input: AccountCreate) {
    try {
      return this.repository.createAccount({
        institution: requireText(input.institution, 'institution'),
        name: requireText(input.name, 'name'),
        type: requireText(input.type, 'type').toLowerCase(),
        currency: normalizeCurrency(input.currency),
        domain: input.domain ?? 'bank',
        source: (input.source ?? 'files').toLowerCase(),
        providerAccountId: input.providerAccountId ?? null,
        metadata: input.metadata ?? {},
      });
    } catch (error) {
      throw asAppError(error);
    }
  }

  listAccounts() {
    return this.repository.listAccounts();
  }

  getAccount(id: string) {
    const account = this.repository.getAccount(id);
    if (!account) throw new AppError('not_found', 'Account not found', { accountId: id });
    return account;
  }

  removeAccount(id: string) {
    const account = this.repository.getAccount(id);
    if (!account) throw new AppError('not_found', 'Account not found', { accountId: id });
    if (['plaid', 'snaptrade'].includes(account.source)) {
      const provider = account.source === 'plaid' ? 'Plaid' : 'SnapTrade';
      const noun = account.source === 'plaid' ? 'bank' : 'brokerage';
      throw new AppError(
        'invalid_input',
        `${account.name} is managed by ${provider}. Remove the ${noun} connection from ${provider} instead of deleting the local account row.`,
        { accountId: id, source: account.source },
      );
    }
    const removed = this.repository.removeAccount(id);
    if (!removed) throw new AppError('not_found', 'Account not found', { accountId: id });
    return { ok: true };
  }

  // Provider-account ids the user has chosen to ignore: they are skipped on every
  // sync (never re-imported) and purged locally. Stored as a JSON array in
  // app_settings so it survives the account row being deleted.
  private ignoredProviderAccounts(): Set<string> {
    try {
      const raw = this.repository.getAppSetting('ignored_provider_accounts');
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return new Set();
    }
  }

  // Stop syncing a provider-managed account and purge its local data. Unlike
  // removeAccount (which refuses provider accounts because a plain sync would
  // recreate them), this records the provider account id on an ignore-list the
  // sync consults, so the account stays gone. Targeted to one account; other
  // accounts (and other users' imports) are unaffected.
  ignoreProviderAccount(id: string) {
    const account = this.repository.getAccount(id);
    if (!account) throw new AppError('not_found', 'Account not found', { accountId: id });
    if (!account.providerAccountId) {
      throw new AppError('invalid_input', 'Only provider-managed accounts can be ignored', { accountId: id });
    }
    const ignored = this.ignoredProviderAccounts();
    ignored.add(account.providerAccountId);
    this.repository.saveAppSettings({ ignored_provider_accounts: JSON.stringify([...ignored]) });
    this.repository.removeAccount(id);
    return { ok: true, providerAccountId: account.providerAccountId };
  }

  listTransactions(query: Partial<TransactionQuery> = {}) {
    if (query.from) assertIsoDate(query.from, 'from');
    if (query.to) assertIsoDate(query.to, 'to');
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new AppError('invalid_input', 'limit must be between 1 and 200');
    }
    return this.repository.listTransactions({
      limit,
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  }

  summarize(query: SummaryQuery = {}) {
    if (query.from) assertIsoDate(query.from, 'from');
    if (query.to) assertIsoDate(query.to, 'to');
    return this.repository.summarize(query);
  }

  listProviderConnections() {
    return this.repository.listProviderConnections();
  }

  listBrokerageTransactions(query: Partial<TransactionQuery> = {}) {
    if (query.from) assertIsoDate(query.from, 'from');
    if (query.to) assertIsoDate(query.to, 'to');
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 300) {
      throw new AppError('invalid_input', 'limit must be between 1 and 300');
    }
    return this.repository.listBrokerageTransactions({
      limit,
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  }

  listBrokerageHoldings(accountId?: string) {
    return this.repository.listBrokerageHoldings(accountId);
  }

  listAccountBalances(accountId?: string) {
    return this.repository.listAccountBalances(accountId);
  }

  summarizeBrokerage() {
    return this.repository.summarizeBrokerage();
  }

  brokerageValueSeries(accountId?: string) {
    return this.repository.brokerageValueSeries(accountId);
  }

  listDashboards() {
    return this.repository.listDashboards();
  }

  listCreditReports() {
    return this.repository.listCreditReports();
  }

  removeCreditReport(id: string) {
    if (!this.repository.removeCreditReport(id)) {
      throw new AppError('not_found', 'Credit report not found');
    }
    return { ok: true, ...this.getCreditOverview() };
  }

  getCreditOverview() {
    const reports = this.repository.listCreditReports().map(sanitizeCreditReport);
    // "Latest" = the report with the newest report date among what remains (so
    // deleting a report falls back to the next most recent one). Mirrors the UI's
    // reportDateTime() so the overview and the reports list always agree.
    const latest = reports.reduce<CreditReportRecord | null>(
      (best, report) => (best && creditReportSortTime(best) >= creditReportSortTime(report) ? best : report),
      null,
    );
    const raw = latest?.raw ?? {};
    const accounts = asArray<CreditTradeline>(raw.accounts);
    const inquiries = asArray<CreditInquiry>(raw.inquiries);
    const suggestions = suggestCreditDisputes(accounts, inquiries);
    const utilization = creditUtilization(accounts);
    return {
      hasData: Boolean(latest),
      reports,
      latest,
      accounts,
      inquiries,
      suggestions,
      utilization,
    };
  }

  listAppSettings(keys?: string[]) {
    return this.repository.listAppSettings(keys);
  }

  saveAppSettings(entries: Record<string, unknown>) {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (!/^[A-Z0-9_]+$/.test(key)) continue;
      if (value === null || value === undefined || value === '') continue;
      clean[key] = String(value);
    }
    const nextProviderId = clean.LLM_PROVIDER?.toLowerCase();
    const currentProviderId = (this.repository.getAppSetting('LLM_PROVIDER') || 'builtin').toLowerCase();
    // Switching away from the built-in model: its in-process weights + KV cache
    // otherwise linger in RAM until the process exits (nothing else unloads on a
    // provider switch). Free them here; a later switch back reloads on demand.
    const leavingBuiltin = Boolean(nextProviderId && nextProviderId !== currentProviderId && currentProviderId === 'builtin');
    if (nextProviderId && nextProviderId !== currentProviderId) {
      const provider = LLM_PROVIDERS.find((candidate) => candidate.id === nextProviderId);
      if (provider) {
        if (!('LLM_BASE_URL' in clean)) clean.LLM_BASE_URL = provider.baseUrl || '';
        // One model per provider — extraction and chat are not distinguished. Seed
        // both the model and the (legacy) chat-model key to the same default so they
        // never diverge; the Settings UI likewise writes a single Model field to both.
        if (!('LLM_MODEL' in clean)) clean.LLM_MODEL = provider.defaultModel;
        if (!('LLM_CHAT_MODEL' in clean)) clean.LLM_CHAT_MODEL = provider.defaultModel;
        if (!('LLM_API_KEY' in clean)) clean.LLM_API_KEY = '';
      }
    }
    this.repository.saveAppSettings(clean);
    if (leavingBuiltin) void this.localModel.unload();
    if (this.backgroundServicesStarted && telegramChatEnabled()) this.telegramGateway.start();
    return { ok: true, saved: Object.keys(clean).length };
  }

  async connectTelegramChat() {
    const token = this.telegramToken();
    if (!token) {
      throw new AppError('invalid_input', 'Save a Telegram bot token first.');
    }
    // Telegram permits one getUpdates consumer. Pause the gateway while the
    // explicit connect action discovers the target chat, then resume it.
    this.telegramGateway.stop();
    try {
      const updatesUrl = telegramApiUrl(token, 'getUpdates');
      updatesUrl.searchParams.set('limit', '10');
      updatesUrl.searchParams.set('timeout', '0');
      updatesUrl.searchParams.set('allowed_updates', JSON.stringify(['message']));
      const updatesResponse = await fetch(updatesUrl, { signal: AbortSignal.timeout(12_000) });
      if (!updatesResponse.ok) {
        throw new AppError('invalid_input', `Telegram getUpdates returned HTTP ${updatesResponse.status}. Check the bot token.`);
      }
      const updatesBody = await updatesResponse.json() as {
        ok?: boolean;
        description?: string;
        result?: Array<{
          update_id?: number;
          message?: {
            chat?: { id?: number | string; type?: string; title?: string; username?: string; first_name?: string; last_name?: string };
            date?: number;
          };
        }>;
      };
      if (!updatesBody.ok) {
        throw new AppError('invalid_input', updatesBody.description || 'Telegram did not accept the bot token.');
      }
      const update = [...(updatesBody.result || [])].reverse().find((item) => item.message?.chat?.id !== undefined);
      const chat = update?.message?.chat;
      if (!chat?.id) {
        throw new AppError('invalid_input', 'Open Telegram, send any message to the bot, then click Connect chat again.');
      }
      const title = chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || String(chat.id);
      this.repository.saveAppSettings({
        TELEGRAM_CHAT_ID: String(chat.id),
        TELEGRAM_CHAT_TITLE: title,
        TELEGRAM_LAST_UPDATE_ID: String(update?.update_id ?? ''),
      });
      await sendTelegramMessage({
        token,
        chatId: String(chat.id),
        text: 'Finora connected this Telegram chat. Ask me anything about your local finances.',
      });
      return {
        ok: true,
        chat: { id: String(chat.id), type: chat.type || 'chat', title },
      };
    } finally {
      if (this.backgroundServicesStarted && telegramChatEnabled()) this.telegramGateway.start();
    }
  }

  async createPlaidLinkToken() {
    const plaid = this.plaidClient();
    try {
      const response = await plaid.linkTokenCreate({
        user: { client_user_id: 'finora-local' },
        client_name: 'Finora',
        products: [Products.Transactions],
        additional_consented_products: [Products.Investments],
        country_codes: [CountryCode.Us],
        language: 'en',
      });
      const token = response.data.link_token;
      if (!token) throw new Error('Plaid did not return a link_token');
      return { link_token: token };
    } catch (error) {
      throw connectorError('Plaid link token creation failed', error);
    }
  }

  async exchangePlaidPublicToken(publicToken: string) {
    const token = requireText(publicToken, 'public_token');
    const plaid = this.plaidClient();
    try {
      const exchange = await plaid.itemPublicTokenExchange({ public_token: token });
      const accessToken = exchange.data.access_token;
      const itemId = exchange.data.item_id;
      const accountsResponse = await plaid.accountsGet({ access_token: accessToken });
      const institutionId = accountsResponse.data.item.institution_id ?? null;
      const institution = institutionId
        ? await plaid.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
        }).then((result) => result.data.institution.name).catch(() => null)
        : null;
      const institutionName = normalizeProviderInstitution(institution || 'Plaid');
      const environment = this.plaidEnvironment();
      const accountIds: string[] = [];

      for (const account of accountsResponse.data.accounts) {
        const plaidAccount = account as typeof account & { iso_currency_code?: string | null; unofficial_currency_code?: string | null };
        accountIds.push(account.account_id);
        this.ensureProviderAccount({
          institution: institutionName,
          name: account.name || account.official_name || account.account_id,
          type: account.subtype || account.type || 'account',
          currency: plaidAccount.iso_currency_code || plaidAccount.unofficial_currency_code || 'USD',
          source: 'plaid',
          providerAccountId: account.account_id,
          domain: plaidAccountDomain(account),
          metadata: {
            plaidItemId: itemId,
            institutionId,
            mask: account.mask ?? null,
            type: account.type ?? null,
            subtype: account.subtype ?? null,
            environment,
            source: 'plaid',
          },
        });
      }

      const connection = this.repository.saveProviderConnection({
        provider: 'plaid',
        externalId: itemId,
        institution: institutionName,
        status: 'active',
        environment,
        accessToken,
        metadata: {
          institutionId,
          accountIds,
          error: null,
          removedAt: null,
          consentExpiresAt: accountsResponse.data.item.consent_expiration_time ?? null,
        },
      });
      return { ok: true, itemId, institution: institutionName, accounts: accountIds.length, connection };
    } catch (error) {
      throw connectorError('Plaid token exchange failed', error);
    }
  }

  async createPlaidUpdateLinkToken(itemId: string, options: { accountSelection?: boolean | undefined } = {}) {
    const id = requireText(itemId, 'item_id');
    const secret = this.repository.getProviderConnectionSecret('plaid', id);
    if (!secret?.accessToken) {
      throw new AppError('invalid_input', 'No saved Plaid access token is available for this Item.', { itemId: id });
    }
    try {
      const response = await this.plaidClient().linkTokenCreate({
        user: { client_user_id: 'finora-local' },
        client_name: 'Finora',
        country_codes: [CountryCode.Us],
        language: 'en',
        access_token: secret.accessToken,
        ...(options.accountSelection ? { update: { account_selection_enabled: true } } : {}),
      } as any);
      const token = response.data.link_token;
      if (!token) throw new Error('Plaid did not return an update link_token');
      return { link_token: token, itemId: id };
    } catch (error) {
      throw connectorError('Plaid update link token creation failed', error);
    }
  }

  async completePlaidUpdate(itemId: string) {
    const id = requireText(itemId, 'item_id');
    const secret = this.repository.getProviderConnectionSecret('plaid', id);
    const connection = this.repository.listProviderConnections().find((item) => item.provider === 'plaid' && item.externalId === id);
    if (!secret?.accessToken || !connection) {
      throw new AppError('invalid_input', 'No saved Plaid access token is available for this Item.', { itemId: id });
    }
    try {
      const { accounts: accountMap, consentExpiresAt } = await this.refreshPlaidAccounts(this.plaidClient(), id, secret.accessToken, connection);
      const liveProviderAccountIds = new Set(accountMap.keys());
      let removedAccounts = 0;
      for (const account of this.accountsForPlaidItem(id, connection)) {
        if (!account.providerAccountId || liveProviderAccountIds.has(account.providerAccountId)) continue;
        if (this.repository.removeAccount(account.id)) removedAccounts += 1;
      }
      this.repository.saveProviderConnection({
        provider: 'plaid',
        externalId: id,
        institution: connection.institution,
        status: 'active',
        environment: connection.environment,
        accessToken: secret.accessToken,
        cursor: secret.cursor,
        metadata: {
          ...secret.metadata,
          accountIds: [...liveProviderAccountIds],
          error: null,
          removedAt: null,
          consentExpiresAt,
          lastUpdateAt: new Date().toISOString(),
        },
      });
      return { ok: true, itemId: id, accounts: liveProviderAccountIds.size, removedAccounts };
    } catch (error) {
      throw connectorError('Plaid account selection update failed', error);
    }
  }

  async createSnapTradePortal() {
    const snaptrade = this.snapTradeClient();
    try {
      const { userId, userSecret } = await this.snapTradeUser(snaptrade);
      const response = await snaptrade.authentication.loginSnapTradeUser({
        userId,
        userSecret,
        connectionType: 'read',
      });
      const url = (response.data as { redirectURI?: string }).redirectURI;
      if (!url) throw new Error('SnapTrade did not return a portal URL');
      this.repository.saveProviderConnection({
        provider: 'snaptrade',
        externalId: userId,
        institution: 'SnapTrade',
        status: 'active',
        accessToken: userSecret,
        metadata: {
          clientId: this.snapTradeCredentials().clientId,
          hasConsumerKey: true,
          connectionType: 'read',
        },
      });
      return { url, userId };
    } catch (error) {
      throw connectorError('SnapTrade Connection Portal failed', error);
    }
  }

  async removeSnapTradeConnection(authorizationId: string) {
    const id = requireText(authorizationId, 'authorization_id');
    const credentials = this.snapTradeCredentials();
    const userId = this.repository.getAppSetting('SNAPTRADE_USER_ID');
    const userSecret = this.repository.getAppSetting('SNAPTRADE_USER_SECRET');
    if (!userId || !userSecret) {
      throw new AppError('invalid_input', 'No SnapTrade user is saved. Open the Connection Portal first.');
    }
    try {
      await new Snaptrade(credentials).connections.removeBrokerageAuthorization({
        authorizationId: id,
        userId,
        userSecret,
      });
      return { ok: true, removed: true, authorizationId: id };
    } catch (error) {
      throw connectorError('SnapTrade connection removal failed', error);
    }
  }

  async syncProviders(): Promise<{ plaid?: ProviderSyncResult; snaptrade?: ProviderSyncResult; insights?: { count: number; sent: boolean; reason?: string } }> {
    if (this.providerSyncInFlight) return this.providerSyncInFlight as Promise<{ plaid?: ProviderSyncResult; snaptrade?: ProviderSyncResult; insights?: { count: number; sent: boolean; reason?: string } }>;
    this.providerSyncInFlight = this.runProviderSync().finally(() => {
      this.providerSyncInFlight = null;
    });
    return this.providerSyncInFlight as Promise<{ plaid?: ProviderSyncResult; snaptrade?: ProviderSyncResult; insights?: { count: number; sent: boolean; reason?: string } }>;
  }

  private async runProviderSync(): Promise<{ plaid?: ProviderSyncResult; snaptrade?: ProviderSyncResult; insights?: { count: number; sent: boolean; reason?: string } }> {
    const result: { plaid?: ProviderSyncResult; snaptrade?: ProviderSyncResult; insights?: { count: number; sent: boolean; reason?: string } } = {};
    // Providers are isolated from one another: a hard failure in one (bad creds, a
    // provider outage) must not skip the others or the insight delivery at the end.
    if (this.plaidConnectionsReady()) {
      try {
        result.plaid = await this.syncPlaid();
      } catch (error) {
        console.warn('Finora Plaid sync failed:', error instanceof Error ? error.message : error);
      }
    }
    // SnapTrade sync is disabled: for accounts also reachable another way it produced
    // duplicate transactions (and inflated realized P&L). Re-enable by flipping
    // SNAPTRADE_SYNC_ENABLED once cross-provider de-duplication is in place.
    if (SNAPTRADE_SYNC_ENABLED && this.snapTradeReady()) {
      try {
        result.snaptrade = await this.syncSnapTrade();
        this.repository.saveAppSettings({ SNAPTRADE_LAST_AUTO_SYNC_AT: new Date().toISOString() });
      } catch (error) {
        console.warn('Finora SnapTrade sync failed:', error instanceof Error ? error.message : error);
      }
    }
    result.insights = await this.deliverInsightsToIm();
    return result;
  }

  private async syncPlaid(): Promise<ProviderSyncResult> {
    const client = this.plaidClient();
    const out: ProviderSyncResult = emptyProviderSyncResult();
    for (const connection of this.repository.listProviderConnections().filter((item) => item.provider === 'plaid' && item.status === 'active' && item.hasAccessToken)) {
      const secret = this.repository.getProviderConnectionSecret('plaid', connection.externalId);
      if (!secret?.accessToken) continue;
      // Isolate each Item: one failing connection must not abort the pass and freeze
      // every other provider. A re-auth-required Item (e.g. ITEM_LOGIN_REQUIRED) is
      // parked by flipping its status off 'active' so the next sync skips it — the
      // connection-health rule then surfaces a reconnect nudge, and completePlaidUpdate
      // restores it. Transient errors leave the Item active so the next tick retries.
      try {
        await this.syncPlaidConnection(client, connection, { accessToken: secret.accessToken, cursor: secret.cursor, metadata: secret.metadata }, out);
      } catch (error) {
        out.errors += 1;
        const info = plaidErrorInfo(error);
        this.repository.saveProviderConnection({
          provider: 'plaid',
          externalId: connection.externalId,
          institution: connection.institution,
          ...(info.reauthRequired ? { status: 'login_required' } : {}),
          metadata: { error: { code: info.code, message: info.message, at: new Date().toISOString(), reauthRequired: info.reauthRequired } },
        });
        console.warn(`Finora Plaid sync failed for ${connection.institution ?? connection.externalId}:`, info.message);
      }
    }
    return out;
  }

  private async syncPlaidConnection(
    client: PlaidApi,
    connection: { externalId: string; institution: string | null; environment: string | null },
    secret: { accessToken: string; cursor: string | null; metadata: Record<string, unknown> },
    out: ProviderSyncResult,
  ): Promise<void> {
    const { accounts: accountMap, consentExpiresAt } = await this.refreshPlaidAccounts(client, connection.externalId, secret.accessToken, connection);
    out.accounts += accountMap.size;
    let nextCursor = secret.cursor || undefined;
    let hasMore = true;
    while (hasMore) {
      const response = await client.transactionsSync({
        access_token: secret.accessToken,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      });
      const data = response.data;
      const transactions: ProviderTransactionInput[] = [];
      for (const transaction of [...data.added, ...data.modified]) {
        const account = accountMap.get(transaction.account_id);
        if (!account || account.domain === 'brokerage') continue;
        const pfc = transaction.personal_finance_category;
        transactions.push({
          accountId: account.id,
          sourceId: transaction.transaction_id,
          date: transaction.date,
          description: transaction.name,
          amountMinor: -toMinor(transaction.amount),
          currency: transaction.iso_currency_code || transaction.unofficial_currency_code || account.currency,
          category: pfc?.primary || (Array.isArray(transaction.category) ? transaction.category.join(' / ') : null),
          pending: transaction.pending,
          metadata: transaction as unknown as Record<string, unknown>,
          fingerprint: `plaid:${transaction.transaction_id}`,
          // A posted transaction supersedes its pending predecessor in place so
          // the stable row id (and therefore the notification identity) survives.
          supersedesFingerprint: transaction.pending_transaction_id
            ? `plaid:${transaction.pending_transaction_id}`
            : null,
        });
      }
      const saved = this.repository.reconcileProviderTransactions(transactions);
      out.transactions += saved.inserted;
      out.skipped += saved.skipped;
      out.modified += data.modified.length + saved.updated;
      // Plaid lists the pending id in `removed` once a charge posts; delete those
      // rows so the ledger keeps a single entry per purchase.
      const removedByAccount = new Map<string, string[]>();
      for (const removed of data.removed) {
        const account = removed.account_id ? accountMap.get(removed.account_id) : undefined;
        if (!account || !removed.transaction_id) continue;
        const fingerprints = removedByAccount.get(account.id) ?? [];
        fingerprints.push(`plaid:${removed.transaction_id}`);
        removedByAccount.set(account.id, fingerprints);
      }
      for (const [accountId, fingerprints] of removedByAccount) {
        out.removed += this.repository.deleteTransactionsByFingerprints(accountId, fingerprints);
      }
      nextCursor = data.next_cursor;
      hasMore = data.has_more;
    }
    const investments = await this.syncPlaidInvestments(client, secret.accessToken, accountMap);
    out.holdings += investments.holdings;
    out.transactions += investments.transactions;
    out.skipped += investments.skipped;
    this.repository.saveProviderConnection({
      provider: 'plaid',
      externalId: connection.externalId,
      institution: connection.institution,
      status: 'active',
      environment: connection.environment,
      accessToken: secret.accessToken,
      cursor: nextCursor,
      metadata: { ...secret.metadata, cursor: nextCursor, lastSyncAt: new Date().toISOString(), error: null, consentExpiresAt },
    });
  }

  private async refreshPlaidAccounts(
    client: PlaidApi,
    itemId: string,
    accessToken: string,
    connection: { institution: string | null; environment: string | null },
  ): Promise<{ accounts: Map<string, { id: string; currency: string; domain: string; type: string }>; consentExpiresAt: string | null }> {
    const response = await client.accountsGet({ access_token: accessToken });
    // OAuth institutions (e.g. Chase) report when the user's consent lapses; capture it so a
    // rule can warn ahead of the hard ITEM_LOGIN_REQUIRED. Null for non-OAuth items.
    const consentExpiresAt = response.data.item.consent_expiration_time ?? null;
    const map = new Map<string, { id: string; currency: string; domain: string; type: string }>();
    const asOfDate = new Date().toISOString().slice(0, 10);
    const institution = connection.institution || normalizeProviderInstitution('Plaid');
    const balances: ProviderBalanceInput[] = [];
    const ignored = this.ignoredProviderAccounts();
    for (const plaidAccount of response.data.accounts) {
      if (ignored.has(String(plaidAccount.account_id))) continue; // user-ignored account
      const currency = plaidAccount.balances?.iso_currency_code || 'USD';
      const domain = plaidAccountDomain(plaidAccount);
      this.ensureProviderAccount({
        institution,
        name: plaidAccount.name || plaidAccount.official_name || plaidAccount.account_id,
        type: plaidAccount.subtype || plaidAccount.type || 'account',
        currency,
        source: 'plaid',
        providerAccountId: plaidAccount.account_id,
        domain,
        metadata: {
          plaidItemId: itemId,
          mask: plaidAccount.mask ?? null,
          type: plaidAccount.type ?? null,
          subtype: plaidAccount.subtype ?? null,
          environment: connection.environment,
          source: 'plaid',
        },
      });
      const account = this.repository.listAccounts().find((item) => item.source === 'plaid' && item.providerAccountId === plaidAccount.account_id);
      if (!account) continue;
      map.set(plaidAccount.account_id, { id: account.id, currency: account.currency, domain, type: account.type });
      const current = plaidAccount.balances?.current;
      const available = plaidAccount.balances?.available;
      if (current !== null || available !== null) {
        balances.push({
          accountId: account.id,
          asOfDate,
          currentMinor: toMinor(current ?? available ?? 0),
          availableMinor: available === null ? null : toMinor(available),
          limitMinor: plaidAccount.balances?.limit === null ? null : toMinor(plaidAccount.balances?.limit ?? null),
          currency,
          metadata: plaidAccount as unknown as Record<string, unknown>,
          fingerprint: `plaid:balance:${plaidAccount.account_id}:${asOfDate}`,
        });
      }
    }
    this.repository.saveProviderBalances(balances);
    return { accounts: map, consentExpiresAt };
  }

  private async syncPlaidInvestments(
    client: PlaidApi,
    accessToken: string,
    accountMap: Map<string, { id: string; currency: string; domain: string; type: string }>,
  ): Promise<Pick<ProviderSyncResult, 'holdings' | 'transactions' | 'skipped'>> {
    const out = { holdings: 0, transactions: 0, skipped: 0 };
    const investmentAccountIds = [...accountMap]
      .filter(([, account]) => account.domain === 'brokerage')
      .map(([providerAccountId]) => providerAccountId);
    if (investmentAccountIds.length === 0) return out;

    const asOfDate = new Date().toISOString().slice(0, 10);
    try {
      const response = await client.investmentsHoldingsGet({
        access_token: accessToken,
        options: { account_ids: investmentAccountIds },
      });
      const securities = new Map((response.data.securities || []).map((security: any) => [String(security.security_id), security]));
      // Plaid reports uninvested cash as a pseudo-security holding (security type
      // 'cash', ticker CUR:USD). That is the account's cash, not a position, so we
      // divert it to the balance's cash_minor instead of storing it as a holding.
      const cashByAccount = new Map<string, number>();
      const holdings: ProviderHoldingInput[] = (response.data.holdings || []).flatMap((holding: any) => {
        const account = accountMap.get(String(holding.account_id));
        if (!account) return [];
        const security = securities.get(String(holding.security_id)) || {};
        const quantity = numberOrNull(holding.quantity);
        const price = numberOrNull(holding.institution_price ?? security.close_price);
        const value = numberOrNull(holding.institution_value);
        if (value === null) return [];
        // Divert cash-equivalent lines to the balance's cash — except on crypto
        // exchanges, which have no cash: there the CUR:USD line is the account's
        // (crypto) market value, so keep it as a holding.
        const isCrypto = (account.type || '').toLowerCase().includes('crypto');
        if (!isCrypto && (security.type === 'cash' || security.ticker_symbol === 'CUR:USD')) {
          cashByAccount.set(account.id, (cashByAccount.get(account.id) ?? 0) + toMinor(value));
          return [];
        }
        const securityId = holding.security_id ? String(holding.security_id) : null;
        const symbol = security.ticker_symbol || security.proxy_security_id || null;
        return [{
          accountId: account.id,
          asOfDate,
          securityId,
          symbol,
          name: security.name || security.ticker_symbol || securityId,
          securityType: security.type || null,
          quantity: quantity === null ? null : String(quantity),
          costBasisMinor: numberOrNull(holding.cost_basis) === null ? null : toMinor(numberOrNull(holding.cost_basis)!),
          priceMinor: price === null ? null : toMinor(price),
          valueMinor: toMinor(value),
          currency: holding.iso_currency_code || security.iso_currency_code || account.currency,
          metadata: { holding, security },
          fingerprint: `plaid:investment:holding:${holding.account_id}:${securityId || symbol || JSON.stringify(holding).slice(0, 40)}:${asOfDate}`,
        }];
      });
      const saved = this.repository.saveProviderHoldings(holdings);
      out.holdings += saved.inserted;
      out.skipped += saved.skipped;
      for (const [accountId, cashMinor] of cashByAccount) {
        this.repository.setBrokerageCashMinor(accountId, asOfDate, cashMinor);
      }
    } catch (error) {
      console.warn('Finora Plaid investments holdings sync failed:', error instanceof Error ? error.message : error);
    }

    try {
      const securities = new Map<string, any>();
      const transactions: ProviderBrokerageTransactionInput[] = [];
      const endDate = new Date().toISOString().slice(0, 10);
      const start = new Date();
      start.setUTCFullYear(start.getUTCFullYear() - 2);
      const startDate = start.toISOString().slice(0, 10);
      const pageSize = 500;
      for (let offset = 0; offset <= 50_000; offset += pageSize) {
        const response = await client.investmentsTransactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { account_ids: investmentAccountIds, count: pageSize, offset },
        });
        for (const security of response.data.securities || []) {
          if ((security as any).security_id) securities.set(String((security as any).security_id), security);
        }
        const rows = response.data.investment_transactions || [];
        for (const transaction of rows as any[]) {
          const account = accountMap.get(String(transaction.account_id));
          if (!account) continue;
          const security = transaction.security_id ? securities.get(String(transaction.security_id)) || {} : {};
          transactions.push({
            accountId: account.id,
            sourceId: transaction.investment_transaction_id ? String(transaction.investment_transaction_id) : null,
            date: plaidInvestmentTransactionDate(transaction),
            description: transaction.name || [transaction.type, transaction.subtype, security.ticker_symbol].filter(Boolean).join(' ') || 'Investment transaction',
            amountMinor: plaidInvestmentAmountMinor(transaction),
            currency: transaction.iso_currency_code || security.iso_currency_code || account.currency,
            symbol: security.ticker_symbol || null,
            investmentType: transaction.type || transaction.subtype || null,
            quantity: transaction.quantity === null || transaction.quantity === undefined ? null : String(transaction.quantity),
            priceMinor: transaction.price === null || transaction.price === undefined ? null : toMinor(transaction.price),
            category: transaction.subtype || transaction.type || null,
            metadata: { transaction, security },
            fingerprint: `plaid:investment:transaction:${transaction.investment_transaction_id || `${transaction.account_id}:${transaction.date}:${transaction.amount}:${transaction.type}:${transaction.security_id || ''}`}`,
          });
        }
        const total = Number(response.data.total_investment_transactions || 0);
        if (rows.length < pageSize || transactions.length >= total) break;
      }
      const saved = this.repository.saveProviderBrokerageTransactions(transactions);
      out.transactions += saved.inserted;
      out.skipped += saved.skipped;
    } catch (error) {
      console.warn('Finora Plaid investments transactions sync failed:', error instanceof Error ? error.message : error);
    }
    return out;
  }

  private async syncSnapTrade(): Promise<ProviderSyncResult> {
    const client = this.snapTradeClient();
    const { userId, userSecret } = await this.snapTradeUser(client);
    const response = await client.accountInformation.listUserAccounts({ userId, userSecret });
    const out: ProviderSyncResult = emptyProviderSyncResult();
    const asOfDate = new Date().toISOString().slice(0, 10);
    const syncErrors: Array<{ accountId: string; accountName: string; stage: string; message: string }> = [];
    const ignored = this.ignoredProviderAccounts();
    for (const snapAccount of (response.data || []) as Array<Record<string, any>>) {
      if (ignored.has(String(snapAccount.id))) continue; // user-ignored account
      const account = this.ensureSnapTradeAccount(snapAccount);
      if (!account) continue;
      out.accounts += 1;
      const currency = account.currency;

      const balance = snapAccount.balance as { total?: { amount?: number; currency?: string } } | undefined;
      const balances: ProviderBalanceInput[] = [];
      let cashMinor: number | null = null;
      let buyingPowerMinor: number | null = null;
      try {
        const balanceResponse = await client.accountInformation.getUserAccountBalance({ userId, userSecret, accountId: String(snapAccount.id) });
        for (const row of (balanceResponse.data || []) as Array<Record<string, unknown>>) {
          cashMinor = (cashMinor ?? 0) + toMinor(Number(row.cash ?? 0));
          buyingPowerMinor = (buyingPowerMinor ?? 0) + toMinor(Number(row.buying_power ?? 0));
        }
      } catch {
        // Some SnapTrade accounts do not expose detailed balance rows.
      }
      const currentMinor = toMinor(Number(balance?.total?.amount ?? 0));
      balances.push({
        accountId: account.id,
        asOfDate,
        currentMinor,
        cashMinor,
        buyingPowerMinor,
        currency: balance?.total?.currency || currency,
        metadata: { snapAccount },
        fingerprint: `snaptrade:balance:${snapAccount.id}:${asOfDate}`,
      });
      const savedBalances = this.repository.saveProviderBalances(balances);
      out.balances += savedBalances.inserted;

      try {
        const positions = await client.accountInformation.getUserAccountPositions({ userId, userSecret, accountId: String(snapAccount.id) });
        const holdings: ProviderHoldingInput[] = ((positions.data || []) as Array<Record<string, any>>).flatMap((position) => {
          const symbol = snapTradeSymbol(position.symbol || {});
          const units = numberOrNull(position.units);
          const price = numberOrNull(position.price);
          const value = units !== null && price !== null ? Math.abs(units * price) : null;
          if (value === null) return [];
          return [{
            accountId: account.id,
            asOfDate,
            securityId: symbol.id,
            symbol: symbol.symbol,
            name: symbol.description,
            securityType: symbol.securityType || (position.cash_equivalent ? 'cash' : null),
            quantity: units === null ? null : String(units),
            costBasisMinor: numberOrNull(position.average_purchase_price) !== null && units !== null
              ? toMinor(numberOrNull(position.average_purchase_price)! * units)
              : null,
            priceMinor: price === null ? null : toMinor(price),
            valueMinor: toMinor(value),
            currency: position.currency?.code || currency,
            metadata: position,
            fingerprint: `snaptrade:holding:${snapAccount.id}:${symbol.id || symbol.symbol || position.id || JSON.stringify(position).slice(0, 40)}:${asOfDate}`,
          }];
        });
        const savedHoldings = this.repository.saveProviderHoldings(holdings);
        out.holdings += savedHoldings.inserted;
        out.skipped += savedHoldings.skipped;
      } catch (error) {
        syncErrors.push({ accountId: account.id, accountName: account.name, stage: 'positions', message: error instanceof Error ? error.message : String(error) });
      }

      try {
        const activities: Array<Record<string, any>> = [];
        const pageSize = 1000;
        for (let offset = 0; offset <= 50_000; offset += pageSize) {
          const page = await client.accountInformation.getAccountActivities({ userId, userSecret, accountId: String(snapAccount.id), offset, limit: pageSize });
          const rows = (Array.isArray(page.data) ? page.data : page.data?.data || []) as Array<Record<string, any>>;
          activities.push(...rows);
          const total = page.data?.pagination?.total;
          if (rows.length < pageSize || (total !== undefined && activities.length >= total)) break;
        }
        const transactions: ProviderBrokerageTransactionInput[] = activities.flatMap((activity) => {
          const date = String(activity.trade_date || activity.settlement_date || '').slice(0, 10);
          if (!date) return [];
          const symbol = snapTradeSymbol(activity.symbol || {});
          return [{
            accountId: account.id,
            sourceId: activity.id ? String(activity.id) : null,
            date,
            description: activity.description || [activity.type, symbol.symbol].filter(Boolean).join(' ') || 'Investment transaction',
            amountMinor: toMinor(Number(activity.amount || 0)),
            currency: activity.currency?.code || currency,
            symbol: symbol.symbol,
            investmentType: activity.type || null,
            quantity: activity.units === undefined || activity.units === null ? null : String(activity.units),
            priceMinor: activity.price === undefined || activity.price === null ? null : toMinor(Number(activity.price)),
            category: activity.type || null,
            metadata: activity,
            fingerprint: `snaptrade:activity:${activity.id || `${snapAccount.id}:${date}:${activity.amount}:${activity.type}:${symbol.symbol || ''}`}`,
          }];
        });
        const savedTransactions = this.repository.saveProviderBrokerageTransactions(transactions);
        out.transactions += savedTransactions.inserted;
        out.skipped += savedTransactions.skipped;
      } catch (error) {
        syncErrors.push({ accountId: account.id, accountName: account.name, stage: 'activities', message: error instanceof Error ? error.message : String(error) });
      }
    }
    this.repository.saveProviderConnection({
      provider: 'snaptrade',
      externalId: userId,
      institution: 'SnapTrade',
      status: 'active',
      accessToken: userSecret,
      metadata: {
        clientId: this.snapTradeCredentials().clientId,
        hasConsumerKey: true,
        lastAutoSyncAt: new Date().toISOString(),
        syncErrors,
      },
    });
    return out;
  }

  startBackgroundServices(): void {
    if (this.backgroundServicesStarted) return;
    this.backgroundServicesStarted = true;
    if (telegramChatEnabled()) this.telegramGateway.start();
    if (autoSyncEnabled()) {
      const periodMs = autoSyncHours() * 60 * 60 * 1_000;
      this.providerSyncKick = setTimeout(() => {
        void this.syncProviders().catch((error: unknown) => {
          console.warn('Finora provider auto-sync failed:', error instanceof Error ? error.message : error);
        });
        this.providerSyncTimer = setInterval(() => {
          void this.syncProviders().catch((error: unknown) => {
            console.warn('Finora provider auto-sync failed:', error instanceof Error ? error.message : error);
          });
        }, periodMs);
        this.providerSyncTimer.unref();
      }, 60_000);
      this.providerSyncKick.unref();
    }

    // Rule feed: pull new built-in rules shortly after boot, then once a day.
    // Silent and best-effort — an unset RULES_FEED_URL (or no feed client) is a
    // no-op, and any failure is logged, not surfaced. Sync is additive and
    // idempotent, so a daily pass that finds nothing new is a cheap no-op.
    const feedSync = () => this.syncRuleFeed().catch((error: unknown) => {
      console.warn('Finora rule-feed sync failed:', error instanceof Error ? error.message : error);
    });
    this.ruleFeedKick = setTimeout(() => {
      void feedSync();
      this.ruleFeedTimer = setInterval(() => { void feedSync(); }, 24 * 60 * 60 * 1_000);
      this.ruleFeedTimer.unref();
    }, 30_000);
    this.ruleFeedKick.unref();

    // Reflection ("dreaming"): distill the agent event log into durable memory.
    // First pass 5 minutes after boot, then once a day. Timers are unref'd so
    // they never keep the process alive.
    this.reflectionKick = setTimeout(() => {
      void this.runReflection().catch((error: unknown) => {
        console.warn('Finora reflection failed:', error instanceof Error ? error.message : error);
      });
      this.reflectionTimer = setInterval(() => {
        void this.runReflection().catch((error: unknown) => {
          console.warn('Finora reflection failed:', error instanceof Error ? error.message : error);
        });
      }, 24 * 60 * 60 * 1_000);
      this.reflectionTimer.unref();
    }, 5 * 60_000);
    this.reflectionKick.unref();

    if (!insightDeliveryEnabled()) return;

    this.alertKick = setTimeout(() => {
      void this.deliverInsightsToIm().catch((error: unknown) => {
        console.warn('Finora insight delivery check failed:', error instanceof Error ? error.message : error);
      });
      this.alertTimer = setInterval(() => {
        void this.deliverInsightsToIm().catch((error: unknown) => {
          console.warn('Finora insight delivery check failed:', error instanceof Error ? error.message : error);
        });
      }, 24 * 60 * 60 * 1_000);
      this.alertTimer.unref();
    }, 30_000);
    this.alertKick.unref();
  }

  async notifyTelegramAlerts(): Promise<{ count: number; sent: boolean; reason?: string }> {
    return this.deliverInsightsToIm();
  }

  async deliverInsightsToIm(): Promise<{ count: number; sent: boolean; reason?: string }> {
    const token = this.telegramToken();
    const chatId = this.repository.getAppSetting('TELEGRAM_CHAT_ID');
    const channel = (this.repository.getAppSetting('NOTIFICATION_CHANNEL') || 'telegram').toLowerCase();
    if (!token || !chatId || channel !== 'telegram') {
      return { count: 0, sent: false, reason: 'telegram-not-configured' };
    }

    const insights = this.activeFindings();
    const current = new Map(insights.map((insight) => [insightIdentity(insight), insight]));
    const previous = parseStringArray(this.repository.getAppSetting('TELEGRAM_ACTIVE_ALERT_KEYS'));
    const fresh = [...current].filter(([key]) => !previous.has(key)).map(([, insight]) => insight);
    if (fresh.length === 0) {
      this.repository.saveAppSettings({
        TELEGRAM_ACTIVE_ALERT_KEYS: JSON.stringify([...current.keys()]),
        TELEGRAM_LAST_ALERT_CHECK_AT: new Date().toISOString(),
      });
      return { count: 0, sent: false, reason: 'no-new-insights' };
    }

    try {
      await sendTelegramMessage({
        token,
        chatId,
        text: formatImInsights(fresh),
      });
      this.repository.saveAppSettings({
        TELEGRAM_ACTIVE_ALERT_KEYS: JSON.stringify([...current.keys()]),
        TELEGRAM_LAST_ALERT_CHECK_AT: new Date().toISOString(),
      });
      return { count: fresh.length, sent: true };
    } catch (error) {
      // Keep only already-delivered insights active. Fresh insights remain eligible
      // for the next run, so a transient IM failure does not lose them.
      this.repository.saveAppSettings({
        TELEGRAM_ACTIVE_ALERT_KEYS: JSON.stringify([...current.keys()].filter((key) => previous.has(key))),
        TELEGRAM_LAST_ALERT_CHECK_AT: new Date().toISOString(),
      });
      console.warn('Finora insight delivery failed:', error instanceof Error ? error.message : error);
      return { count: fresh.length, sent: false, reason: 'send-failed' };
    }
  }

  listFindings() {
    return this.activeFindings().map((finding) => this.annotateArtifact(finding));
  }

  // Advertise which Advisor document (if any) Finora can draft for a finding, so
  // the UI can offer it. This lives in the application layer, not the engine,
  // because artifact specs are a delivery concern — the rule logic never changes.
  private annotateArtifact(finding: Finding): Finding {
    const spec = ARTIFACT_SPECS[finding.kind];
    if (!spec || !finding.action) return finding;
    return { ...finding, action: { ...finding.action, artifactType: spec.artifactType } };
  }

  // Advisor tier: draft the document that helps the user act on a finding. The
  // numbers, dates, and merchant come deterministically from the finding's
  // evidence; the model only turns them into prose (see ARTIFACT_SPECS). Findings
  // are computed on read and never persisted, so the caller passes the finding id
  // and we re-derive it here. Gated on a real model being present — the injected
  // recurring classifier does NOT count, since this path actually calls the LLM.
  async generateFindingArtifact(findingId: string): Promise<
    | { status: 'not_found' }
    | { status: 'unsupported' }
    | { status: 'model_required'; provider: string; needsDownload: boolean }
    | { status: 'ok'; findingId: string; artifactType: string; title: string; artifact: string }
  > {
    const finding = this.activeFindings().find((candidate) => candidate.id === findingId);
    if (!finding) return { status: 'not_found' };
    const spec = ARTIFACT_SPECS[finding.kind];
    if (!spec) return { status: 'unsupported' };

    const llm = this.llmConfig();
    const modelReady = llm.provider === 'builtin' ? await this.localModel.weightsPresent(llm.model) : llm.keySet;
    if (!modelReady) {
      return { status: 'model_required', provider: llm.provider, needsDownload: llm.provider === 'builtin' };
    }

    // Resolve the finding's evidence records to their transactions (fact:* refs,
    // used by fact-gated rules, are not transactions and are skipped).
    const txIds = finding.evidence.records.filter((record) => record && !record.startsWith('fact:'));
    const txById = new Map(this.repository.listTransactionsByIds(txIds).map((tx) => [tx.id, tx]));
    const accountName = new Map(this.repository.listAccounts().map((account) => [account.id, account.name]));
    const charges = txIds
      .map((id) => txById.get(id))
      .filter((tx): tx is Transaction => Boolean(tx))
      .map((tx) => ({
        date: tx.date,
        description: tx.description,
        amount: formatMinorAmount(Math.abs(tx.amountMinor), tx.currency),
        account: accountName.get(tx.accountId) ?? tx.accountId,
      }));

    const context = {
      today: new Date().toISOString().slice(0, 10),
      finding: {
        title: finding.title,
        detail: finding.detail,
        value: finding.value,
        estimatedImpact: finding.dollarImpactMinor ? formatMinorAmount(Math.abs(finding.dollarImpactMinor), finding.currency) : null,
      },
      charges,
    };

    let artifact: string;
    try {
      artifact = (await this.llmReply(llm, {
        system: spec.system,
        messages: [{ role: 'user', content: JSON.stringify(context) }],
        timeoutMs: 120_000,
        maxTokens: 1_200,
      })).trim();
    } catch (error) {
      throw asAppError(error);
    }
    if (!artifact) throw new AppError('external_service', 'The model did not return a draft. Please try again.');
    return { status: 'ok', findingId, artifactType: spec.artifactType, title: spec.title, artifact };
  }

  listRules() {
    // All rules are built-in definitions; the UI shows every one with an on/off
    // switch. No hidden subset.
    return this.repository.listRules();
  }


  async previewRule(input: { text: string; scope?: string | undefined; cadence?: string | undefined; channel?: string | undefined; scheduledHour?: number | null | undefined; scheduledDay?: number | null | undefined }) {
    const text = requireText(input.text, 'text');
    const heuristic = inferRule(this.repository.listRuleSpecs(), text, input.scope, input.cadence);
    const refined = await this.inferRuleWithModel(text, heuristic);
    const inferred = { ...heuristic, scope: refined.scope, cadence: refined.cadence };
    const scheduledHour = input.scheduledHour ?? suggestedRuleHour(inferred.cadence);
    return {
      text,
      ...inferred,
      scheduledHour,
      scheduledDay: input.scheduledDay ?? null,
      executionClass: inferred.executionClass,
      strategy: executionStrategy(inferred.executionClass),
      inference: refined.inference,
    };
  }

  createRule(input: { text: string; scope?: string | undefined; cadence?: string | undefined; channel?: string | undefined; scheduledHour?: number | null | undefined; scheduledDay?: number | null | undefined }) {
    const text = requireText(input.text, 'text');
    const inferred = inferRule(this.repository.listRuleSpecs(), text, input.scope, input.cadence);
    // Adopt the matched rule definition into the user's list. The rule's logic and
    // domain come from its definition; the user owns only the schedule/channel.
    const rule = this.repository.adoptRule(inferred.kind, {
      sourceText: text,
      cadence: inferred.cadence,
      channel: inferred.channel,
      scheduledHour: input.scheduledHour ?? null,
      scheduledDay: input.scheduledDay ?? null,
    });
    if (!rule) throw new AppError('not_found', 'No rule definition matched', { kind: inferred.kind });
    return rule;
  }

  toggleRule(kind: string, active: boolean) {
    const rule = this.repository.toggleRule(kind, active);
    if (!rule) throw new AppError('not_found', 'Rule not found', { kind });
    return rule;
  }

  updateRuleSchedule(input: { kind: string; cadence?: string | undefined; scheduledHour?: number | null | undefined; scheduledDay?: number | null | undefined }) {
    const kind = requireText(input.kind, 'kind');
    const rule = this.repository.updateRuleSchedule(kind, {
      cadence: input.cadence ?? 'event',
      scheduledHour: input.scheduledHour ?? null,
      scheduledDay: input.scheduledDay ?? null,
    });
    if (!rule) throw new AppError('not_found', 'Rule not found', { kind });
    return rule;
  }

  // --- Custom (user-authored) rules -----------------------------------------
  // A custom rule is authored from natural language: the configured model turns
  // the description into a deterministic (D) SQL query, which the engine then runs
  // exactly like a built-in. Unlike createRule (which adopts an existing built-in
  // definition), these are new rows with source = 'user' — the only rules the user
  // may edit the content of or delete. See docs/rules-design.md.

  // Author + validate a custom rule's SQL without persisting, so the UI can show
  // the generated query and inferred settings before the user commits.
  async previewCustomRule(input: { text: string; scope?: string | undefined; cadence?: string | undefined; scheduledHour?: number | null | undefined; scheduledDay?: number | null | undefined }) {
    const text = requireText(input.text, 'text');
    const draft = await this.authorCustomRule(text);
    const cadence = normalizeChoice(input.cadence ?? 'event', RULE_CADENCES, 'event');
    // The user may override the model-inferred category; domain follows scope.
    const scope = input.scope ? normalizeChoice(input.scope, RULE_SCOPES, draft.scope) : draft.scope;
    const domain = SCOPE_TO_DOMAIN[scope] ?? draft.domain;
    return {
      text,
      kind: null,
      domain,
      scope,
      executionClass: 'D' as const,
      cadence,
      scheduledHour: input.scheduledHour ?? suggestedRuleHour(cadence),
      scheduledDay: input.scheduledDay ?? null,
      sql: draft.sql,
      title: draft.title,
      strategy: executionStrategy('D'),
    };
  }

  // Author + validate + persist a new custom rule (source = 'user'), active by
  // default. The kind is minted here — the model never owns identity.
  async createCustomRule(input: { text: string; scope?: string | undefined; cadence?: string | undefined; scheduledHour?: number | null | undefined; scheduledDay?: number | null | undefined }) {
    const text = requireText(input.text, 'text');
    const draft = await this.authorCustomRule(text);
    const cadence = normalizeChoice(input.cadence ?? 'event', RULE_CADENCES, 'event');
    // The user may override the model-inferred category; domain follows scope.
    const scope = input.scope ? normalizeChoice(input.scope, RULE_SCOPES, draft.scope) : draft.scope;
    const domain = SCOPE_TO_DOMAIN[scope] ?? draft.domain;
    const kind = this.mintUserRuleKind(text);
    const spec: RuleSpec = {
      kind,
      domain,
      executionClass: 'D',
      actionTier: 'observer',
      scope,
      cadence,
      keywords: draft.keywords,
      sql: draft.sql,
      prompt: null,
      facts: [],
      enabled: true,
      source: 'user',
      version: 1,
    };
    return this.repository.createUserRule(spec, {
      sourceText: text,
      cadence,
      channel: 'auto',
      scheduledHour: input.scheduledHour ?? suggestedRuleHour(cadence),
      scheduledDay: input.scheduledDay ?? null,
    });
  }

  // Rewrite a custom rule's content by regenerating its SQL from new natural
  // language. Only user rules may be edited; built-in/downloaded content is fixed.
  async updateCustomRuleContent(input: { kind: string; text: string; scope?: string | undefined }) {
    const kind = requireText(input.kind, 'kind');
    const text = requireText(input.text, 'text');
    const existing = this.repository.getRule(kind);
    if (!existing) throw new AppError('not_found', 'Rule not found', { kind });
    if (existing.source !== 'user') {
      throw new AppError('invalid_input', 'Only custom rules can be edited; built-in rules have fixed content.', { kind, source: existing.source });
    }
    const scope = input.scope ? normalizeChoice(input.scope, RULE_SCOPES, existing.scope) : existing.scope;
    const domain = (SCOPE_TO_DOMAIN[scope] ?? existing.domain) as RuleDomain;
    // Re-authoring runs the model (non-deterministic and slow), so only do it when
    // the description actually changed. A category-only edit just updates the two
    // classification columns and leaves the validated SQL untouched.
    if ((existing.sourceText ?? '') === text) {
      const rule = this.repository.updateUserRuleClassification(kind, { domain, scope });
      if (!rule) throw new AppError('not_found', 'Rule not found', { kind });
      return rule;
    }
    const draft = await this.authorCustomRule(text);
    const rule = this.repository.updateUserRuleContent(kind, {
      sql: draft.sql,
      keywords: draft.keywords,
      domain,
      scope,
      sourceText: text,
    });
    if (!rule) throw new AppError('not_found', 'Rule not found', { kind });
    return rule;
  }

  // Delete a rule. Only custom (source = 'user') rules may be deleted; built-in and
  // downloaded rules are protected (disable them with toggleRule instead).
  deleteRule(kind: string) {
    const key = requireText(kind, 'kind');
    const existing = this.repository.getRule(key);
    if (!existing) throw new AppError('not_found', 'Rule not found', { kind: key });
    if (existing.source !== 'user') {
      throw new AppError('invalid_input', 'Built-in and downloaded rules cannot be deleted; disable them instead.', { kind: key, source: existing.source });
    }
    const removed = this.repository.deleteRule(key);
    if (!removed) throw new AppError('not_found', 'Rule not found', { kind: key });
    return { kind: key, deleted: true };
  }

  // Run the injected author, then validate the generated SQL against the live DB on
  // the read-only connection before it is ever persisted or scheduled.
  private async authorCustomRule(text: string): Promise<RuleSqlDraft> {
    // The author is non-deterministic, and even a mid-size model intermittently emits
    // unparseable JSON or SQL that fails validation (unknown column, bad alias/CTE
    // scoping, syntax). Retry a few times — and when a candidate parses but fails
    // validation, feed the exact SQLite error + the failed SQL back so the next
    // attempt can *fix that specific mistake* rather than guess afresh (self-repair).
    // A missing model won't fix itself — bail on it.
    const maxAttempts = 5;
    let lastError: unknown;
    let repair: { sql: string; error: string } | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let draft: RuleSqlDraft;
      try {
        draft = await this.ruleSqlAuthor({ text, repair });
      } catch (error) {
        lastError = error;
        if (error instanceof AppError && error.details?.reason === 'needs_download') throw error;
        continue; // authoring/parse failed — no SQL to repair from, try again
      }
      try {
        this.validateRuleSql(draft.sql);
        return {
          sql: draft.sql,
          title: draft.title || 'Custom rule',
          keywords: draft.keywords || text.toLowerCase().slice(0, 120),
          domain: normalizeChoice(draft.domain, RULE_DOMAINS, 'banking') as RuleDomain,
          scope: normalizeChoice(draft.scope, RULE_SCOPES, 'banking'),
        };
      } catch (error) {
        lastError = error;
        // Hand the model its own broken query and the reason it failed.
        repair = { sql: draft.sql, error: error instanceof Error ? error.message : 'query failed' };
      }
    }
    // All attempts failed. Surface the underlying error, plus a hint about the most
    // likely remedy: small local models often can't author complex rules reliably.
    if (lastError instanceof AppError) {
      const hint = this.llmConfig().local
        ? ' A small local model can struggle to author complex rules — try a more capable model (Settings → Models) or simplify the description.'
        : ' Try simplifying or rephrasing the rule.';
      throw new AppError(lastError.code, `${lastError.message}${hint}`, lastError.details);
    }
    throw lastError;
  }

  // Execute the candidate SQL once on the read-only connection with the engine's
  // param superset. A driver error (write attempt, bad SQL) or a result row missing
  // the required finding-draft columns rejects the rule before it can be saved.
  private validateRuleSql(sql: string) {
    let rows: Record<string, unknown>[];
    try {
      rows = this.repository.runRuleQuery(sql, RULE_SQL_VALIDATION_PARAMS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'query failed';
      throw new AppError('invalid_input', `Generated rule query was invalid: ${message}`, { sql });
    }
    const first = rows[0];
    if (first) {
      const missing = REQUIRED_RULE_COLUMNS.filter((column) => !(column in first));
      if (missing.length > 0) {
        throw new AppError('invalid_input', `Generated rule query is missing required columns: ${missing.join(', ')}`, { sql, missing });
      }
    }
  }

  // The schema block for the author prompt, read from the live DB so it never drifts
  // from the real tables. Cached per process (the schema is stable within a run).
  private ruleSchemaSummaryCache: string | null = null;
  private ruleSchemaSummary(): string {
    if (this.ruleSchemaSummaryCache !== null) return this.ruleSchemaSummaryCache;
    const lines: string[] = [];
    for (const name of RULE_SCHEMA_TABLES) {
      try {
        // name is a trusted constant (not user input), so inlining it is injection-safe.
        // pragma_table_info works for both tables and views, giving real column names.
        const cols = this.repository.runRuleQuery(`SELECT name FROM pragma_table_info('${name}')`, {});
        const columns = cols.map((row) => String(row.name)).filter(Boolean);
        if (columns.length) lines.push(`- ${name}(${columns.join(', ')})`);
      } catch {
        // Table/view absent in this DB — skip it rather than fail authoring.
      }
    }
    this.ruleSchemaSummaryCache = lines.join('\n');
    return this.ruleSchemaSummaryCache;
  }

  // Assemble the full author system prompt: static header + live schema + static footer.
  private ruleAuthorSystemPrompt(): string {
    return `${RULE_SQL_AUTHOR_HEADER}\n\nReadable tables/columns (query only these):\n${this.ruleSchemaSummary()}\n\n${RULE_SQL_AUTHOR_FOOTER}`;
  }

  // Output-token budget for rule authoring, scaled to model capability. A small model
  // handed a large budget mostly fills it with repetition (→ truncation/garbage); a
  // capable one needs room to finish a long query. We size by the best "size" signal
  // each provider gives us: built-in models expose weight bytes; Ollama tags usually
  // encode the parameter count (":9b"); hosted models are all large. A SQL rule never
  // needs more than the 8k cap.
  private ruleAuthorMaxTokens(llm: ReturnType<typeof this.llmConfig>): number {
    const CAP = 8_192;
    if (llm.provider === 'builtin') {
      // ~7B+ local weights get more room than a ~4B; both stay modest (CPU + small ctx).
      return getBuiltinModel(llm.model).approxSizeBytes >= 5_000_000_000 ? 4_096 : 2_048;
    }
    if (llm.provider === 'ollama') {
      // Read the parameter-size hint from the tag (e.g. "qwen3.5:9b" -> 9), if present.
      const params = Number(/:(\d+(?:\.\d+)?)\s*b\b/i.exec(llm.model)?.[1]);
      if (!Number.isFinite(params)) return 6_144; // unknown size — moderate
      return params >= 7 ? CAP : 4_096;           // 7B+ (e.g. qwen3.5:9b) validated at 8k
    }
    return CAP; // hosted frontier models
  }

  // Production NL→SQL author (default RuleSqlAuthor). Asks the configured model for
  // a deterministic query over the local schema, returning strict JSON.
  private async authorRuleSqlWithModel({ text, repair }: { text: string; repair?: { sql: string; error: string } | undefined }): Promise<RuleSqlDraft> {
    const llm = this.llmConfig();
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: text }];
    if (repair) {
      // Self-repair turn: show the model its own failed query and the exact SQLite
      // error so it fixes that specific problem (e.g. an alias/CTE that didn't select
      // the referenced column) instead of regenerating from scratch.
      messages.push({ role: 'assistant', content: JSON.stringify({ sql: repair.sql }) });
      messages.push({
        role: 'user',
        content: `That query failed validation with SQLite error: ${repair.error}\n`
          + 'Return corrected JSON. Only reference columns that exist in the schema above, and make sure every table alias you use is defined and selects the columns you read from it.',
      });
    }
    try {
      const reply = await this.llmReply(llm, {
        system: this.ruleAuthorSystemPrompt(),
        messages,
        timeoutMs: 120_000,
        // Budget scaled to model capability (see ruleAuthorMaxTokens). Too small a
        // budget truncates schema-heavy SQL mid-statement ("incomplete input"); too
        // large lets a weak model ramble. For Ollama this also grows num_ctx (sized
        // from maxTokens), still under the 32768 cap.
        maxTokens: this.ruleAuthorMaxTokens(llm),
        // This call wants strict JSON, not reasoning. A reasoning model (Qwen3.5)
        // otherwise spends the token budget inside <think> and returns empty or
        // truncated output, so authoring fails intermittently. Match the chat/test
        // paths and skip thinking (also faster on a CPU-bound local model).
        disableThinking: true,
      });
      const parsed = parseRuleSqlDraft(reply);
      if (!parsed) throw new Error('the model did not return a SQL rule');
      return parsed;
    } catch (error) {
      if (error instanceof ModelNotDownloadedError) {
        throw new AppError('invalid_input', error.message, { provider: llm.provider, reason: 'needs_download' });
      }
      const message = error instanceof Error ? error.message : 'authoring failed';
      throw new AppError('invalid_input', `Could not author a rule from that description: ${message}`);
    }
  }

  // user:<slug>-<8 hex>. The random suffix keeps the primary key unique even when
  // two rules slug to the same words.
  private mintUserRuleKind(text: string): string {
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'rule';
    return `user:${slug}-${randomUUID().slice(0, 8)}`;
  }

  // --- Facts and questions --------------------------------------------------
  // Facts are values the user knows but the account stream does not expose. A
  // rule blocked on a missing required fact produces a ranked question instead of
  // failing; answering it unlocks the rule. See docs/rules-design.md.

  listQuestions() {
    this.refreshQuestions();
    return this.repository.listQuestions('pending');
  }

  listFacts() {
    return this.repository.listFacts();
  }

  saveFact(input: { key: string; value: string; source?: 'user' | 'derived' | 'reference' | undefined; refreshAfter?: string | null | undefined }) {
    const key = requireText(input.key, 'key');
    const value = requireText(input.value, 'value');
    const source = input.source ?? 'user';
    const fact = this.repository.upsertFact({
      key,
      value,
      source,
      // User-entered facts carry lower confidence than stream-derived ones; that
      // difference propagates into finding confidence and caps the action tier.
      confidence: source === 'user' ? 0.7 : source === 'derived' ? 0.9 : 0.95,
      refreshAfter: input.refreshAfter ?? null,
    });
    this.refreshQuestions();
    return fact;
  }

  removeFact(key: string) {
    return { removed: this.repository.removeFact(key) };
  }

  // The user facts each rule declares, with satisfaction, plus the deduped set of
  // still-unanswered facts. Computed from rules.facts ∪ the facts table so a
  // rule's needs show regardless of whether it is enabled — the UI uses byKind to
  // gate a rule and pending to prompt for the answers. Facts stay decoupled: a rule
  // references keys, and one answered key satisfies every rule that needs it.
  factNeeds() {
    const known = new Set(this.repository.listFacts().map((fact) => fact.key));
    const byKind: Record<string, { kind: string; title: string; domain: string; facts: Array<{ key: string; prompt: string; expects: FactExpectation; satisfied: boolean }> }> = {};
    const pending = new Map<string, { key: string; prompt: string; expects: FactExpectation }>();
    for (const spec of this.repository.listRuleSpecs()) {
      if (!spec.enabled || spec.facts.length === 0) continue;
      const facts = spec.facts.map((need) => {
        const expects = need.expects ?? 'text';
        const satisfied = known.has(need.key);
        if (!satisfied && !pending.has(need.key)) pending.set(need.key, { key: need.key, prompt: need.prompt, expects });
        return { key: need.key, prompt: need.prompt, expects, satisfied };
      });
      byKind[spec.kind] = { kind: spec.kind, title: factRuleTitle(spec.kind), domain: spec.domain, facts };
    }
    return { byKind, pending: [...pending.values()] };
  }

  // Answer a fact question: normalize/validate the raw input, then store it. A
  // configured remote model refines free text ("about 6 %" -> "6"); offline or with
  // the built-in model it falls back to a deterministic parse keyed on `expects`.
  // Stored as a `user` fact, so its low confidence caps any resulting action tier.
  async answerFact(input: { key: string; value: string }) {
    const key = requireText(input.key, 'key');
    const raw = requireText(input.value, 'value');
    const need = this.findFactNeed(key);
    const expects = need?.expects ?? 'text';
    const normalized = await this.normalizeFactValue(raw, expects, need?.prompt ?? key);
    return this.saveFact({ key, value: normalized, source: 'user' });
  }

  private findFactNeed(key: string): RuleFactNeed | undefined {
    for (const spec of this.repository.listRuleSpecs()) {
      const need = spec.facts.find((fact) => fact.key === key);
      if (need) return need;
    }
    return undefined;
  }

  private async normalizeFactValue(raw: string, expects: FactExpectation, prompt: string): Promise<string> {
    let candidate = raw;
    const llm = this.llmConfig();
    // Skip the built-in local model: normalization must stay fast and deterministic
    // offline, so only a configured, key-bearing remote model refines the input.
    if (llm.provider !== 'builtin' && llm.keySet) {
      try {
        const reply = await this.llmReply(llm, {
          system: [
            'Normalize one user-provided value for a personal-finance fact.',
            `Question asked: "${prompt}"`,
            `Expected type: ${expects}.`,
            'Return only compact JSON: {"value":"<normalized>"}.',
            'currency: whole dollars, digits only (e.g. 120000). percent: the number only, no % sign (e.g. 6 or 6.5).',
            'date: ISO YYYY-MM-DD. number: digits only. text: a short clean string.',
            'If the input has no usable value, return {"value":""}.',
          ].join('\n'),
          messages: [{ role: 'user', content: raw }],
          timeoutMs: 1_500,
          maxTokens: 60,
        });
        const parsed = parseRuleInference(reply) as { value?: unknown };
        if (parsed && typeof parsed.value === 'string' && parsed.value.trim()) candidate = parsed.value;
      } catch {
        candidate = raw;
      }
    }
    const normalized = normalizeFactScalar(candidate, expects);
    if (!normalized) throw new AppError('invalid_input', `Could not read a ${expects} value from "${raw}".`);
    return normalized;
  }

  dismissQuestion(id: string) {
    return { dismissed: this.repository.updateQuestionStatus(id, 'dismissed') };
  }

  // Over-the-air rule delivery. Fetches the configured feed URL, validates it, and
  // INSERTS any rule whose kind this install doesn't already have. Existing rules
  // are never overwritten, so the feed is an additive catalog of built-in rules — a
  // way to ship new rules to installed versions without a code release, no redeploy.
  // Dedup is by kind, so a re-sync that finds nothing new is a cheap no-op; the
  // feed's `version` is informational only (shown in the UI, not gated on). The
  // read-only query runner sandboxes downloaded SQL — it can never write. See
  // docs/rules-design.md.
  async syncRuleFeed(): Promise<{ applied: number; skipped: boolean; version: number | null; reason?: string }> {
    const url = (this.repository.getAppSetting('RULES_FEED_URL') || '').trim();
    if (!url) return { applied: 0, skipped: true, version: null, reason: 'no-feed-url' };
    if (!this.ruleFeed) return { applied: 0, skipped: true, version: null, reason: 'no-client' };

    // A network failure (unreachable URL, DNS, timeout) is not an error the user
    // can fix from here — report it as a skip so the manual button degrades
    // gracefully instead of 500ing. A malformed-but-reachable feed still throws
    // (a 422), because that is a real, fixable problem with the feed itself.
    let body: string;
    try {
      body = await this.ruleFeed.fetchFeed(url);
    } catch {
      return { applied: 0, skipped: true, version: null, reason: 'fetch-failed' };
    }
    const feed = parseRuleFeed(body);

    // Additive only: insert the rules this install doesn't already have. Rules
    // already present — whether from the built-in code seed or an earlier sync —
    // are left untouched. The feed distributes NEW built-in rules to installed
    // versions; it never re-syncs or overwrites an existing rule. Dedup by kind
    // is what makes a repeated sync safe, so there is no version gate: applying
    // an unchanged feed simply finds nothing fresh and returns applied: 0.
    const existing = new Set(this.repository.listRuleSpecs().map((spec) => spec.kind));
    const fresh = feed.specs.filter((spec) => !existing.has(spec.kind));
    for (const spec of fresh) this.repository.upsertRuleSpec({ ...spec, source: 'downloaded' });
    // Surface any user input the freshly-added rules need right away.
    this.refreshQuestions();
    return { applied: fresh.length, skipped: false, version: feed.version };
  }

  listFindingMutes() {
    return this.repository.listFindingMutes();
  }

  createFindingMute(input: { kind?: string | null | undefined; accountId?: string | null | undefined; label?: string | null | undefined; days?: number | null | undefined }) {
    const days = Number(input.days || 0);
    const expiresAt = Number.isFinite(days) && days > 0
      ? new Date(Date.now() + Math.round(days) * 86_400_000).toISOString()
      : null;
    return this.repository.saveFindingMute({
      kind: input.kind || null,
      accountId: input.accountId || null,
      label: input.label || null,
      expiresAt,
    });
  }

  removeFindingMute(id: string) {
    return { removed: this.repository.removeFindingMute(id) };
  }

  // --- Agent memory ---------------------------------------------------------
  // Memory is a single markdown profile with four fixed sections. `recallMemory`
  // returns the whole document (lazily seeding the default), `remember` rewrites
  // it with a durable fact, and reflection distills it from the event log.

  recallMemory(): { markdown: string } {
    const stored = this.repository.getUserProfileMarkdown();
    if (stored != null) return { markdown: stored };
    this.repository.saveUserProfileMarkdown(DEFAULT_PROFILE);
    return { markdown: DEFAULT_PROFILE };
  }

  remember(input: { value: string; section?: string; kind?: string }): {
    ok: true;
    section: MemorySection;
    saved: string;
    omittedFinancialNumbers: boolean;
  } {
    const value = (input.value ?? '').trim();
    if (!value) throw new AppError('invalid_input', 'A value to remember is required');
    const section = sectionFromKind(input.kind, input.section);
    const current = this.recallMemory().markdown;
    const result = applyRemember(current, value, section);
    this.repository.saveUserProfileMarkdown(result.markdown);
    return { ok: true, section, saved: result.saved, omittedFinancialNumbers: result.omittedFinancialNumbers };
  }

  forgetMemory(): never {
    // Faithful to the original MVP: memory is one rewritten document, so there is
    // no targeted delete. Correct a fact with `remember` or let reflection revise it.
    throw new AppError(
      'invalid_input',
      'Targeted forget is not supported. Memory is a single rewritten document; correct it with remember or let reflection revise it.',
    );
  }

  // The asynchronous "dreaming" path: read every agent event since the cursor,
  // ask the model to rewrite the profile, and advance the cursor. On any failure
  // the cursor stays put so the same events are retried next run.
  async runReflection(): Promise<{ status: 'no-events' | 'reflected' | 'skipped'; events?: number }> {
    const now = new Date().toISOString();
    const since = this.repository.getReflectionCursor();
    const events = this.repository.listAgentEventsSince(since, now);
    if (events.length === 0) {
      this.repository.setReflectionCursor(now);
      return { status: 'no-events' };
    }
    const current = this.recallMemory().markdown;
    const transcript = events
      .map((event) => {
        const label = [event.eventType, event.role, event.toolName].filter(Boolean).join('/');
        return `[${label}] ${event.content ?? ''}`;
      })
      .join('\n')
      .slice(0, 12_000);
    const llm = this.llmConfig();
    try {
      const reply = await this.llmReply(llm, {
        system: REFLECTION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              'Current profile:',
              '',
              current,
              '',
              'New interaction log (oldest first):',
              '',
              transcript,
              '',
              'Return the full rewritten profile as markdown.',
            ].join('\n'),
          },
        ],
        timeoutMs: 120_000,
        maxTokens: 1_800,
      });
      const next = normalizeProfileMarkdown(extractMarkdown(reply));
      if (profileIsEmpty(next)) {
        this.repository.setReflectionCursor(now);
        return { status: 'skipped', events: events.length };
      }
      this.repository.saveUserProfileMarkdown(next);
      this.repository.setReflectionCursor(now);
      return { status: 'reflected', events: events.length };
    } catch (error) {
      console.warn('Finora reflection failed:', error instanceof Error ? error.message : error);
      return { status: 'skipped', events: events.length };
    }
  }

  private recordAgentEvent(input: AgentEventInput): void {
    // Audit failures must never break chat, so swallow and log.
    try {
      this.repository.appendAgentEvent(input);
    } catch (error) {
      console.warn('Finora agent event log failed:', error instanceof Error ? error.message : error);
    }
  }

  async chat(messages: ChatMessage[], section?: string, contextAttachments: ChatContextAttachment[] = []) {
    const prompt = messages.at(-1)?.content?.trim();
    if (!prompt) throw new AppError('invalid_input', 'A chat message is required');
    const turnId = randomUUID();
    this.recordAgentEvent({ turnId, eventType: 'user_message', role: 'user', content: prompt });
    const context = {
      ...this.chatContext(section),
      selectedContext: contextAttachments.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        section: item.section,
        totalRows: item.totalRows,
        columns: item.columns,
        rows: item.rows,
        artifact: item.artifact,
        note: item.note,
      })),
    };
    const llm = this.llmConfig();
    const memory = this.recallMemory().markdown;
    const system = [
      'You are Finora, a local-first personal finance assistant.',
      'Use only the local context provided below. Do not claim to have synced live accounts.',
      'Do not provide financial, tax, or legal advice. Give factual summaries, point out risks, and suggest review steps.',
      'All fields ending in Minor are minor currency units. Divide them by 100 before presenting dollars.',
      'Keep replies concise and use the user language when obvious.',
      'If a requested action is not available, say what local screen or setting to use.',
      '',
      MEMORY_POLICY,
      '',
      memoryContext(memory),
      '',
      'Local context:',
      // Compact (no indentation): a local CPU model must prefill this whole system
      // prompt, and pretty-printing spends 30-50% of the tokens on whitespace for zero
      // information gain — a direct hit to prefill latency (the cause of chat timeouts).
      JSON.stringify(context),
    ].join('\n');
    try {
      const reply = await this.llmReply(llm, {
        system,
        messages: messages.slice(-8),
        // A local model prefilling a full ledger snapshot on CPU can take minutes; allow
        // 5 minutes before giving up (the built-in path honors this signal). The HTTP
        // server's requestTimeout is raised past this so it never races (see server.ts).
        timeoutMs: 300_000,
        maxTokens: 768,
        // Reasoning models (Qwen3.5) otherwise spend the whole 768-token budget inside
        // <think> and return an empty answer. Chat wants the answer, not the reasoning,
        // and skipping <think> is also much faster on a CPU-bound local model.
        disableThinking: true,
      });
      this.recordAgentEvent({ turnId, eventType: 'assistant_message', role: 'assistant', content: reply });
      return { provider: llm.provider, model: llm.chatModel, local: llm.local, reply };
    } catch (error) {
      if (error instanceof ModelNotDownloadedError) {
        throw new AppError('invalid_input', error.message, { provider: llm.provider, reason: 'needs_download' });
      }
      const message = error instanceof Error ? error.message : 'The configured model request failed';
      throw new AppError('external_service', `LLM request failed: ${message}`, {
        provider: llm.provider,
        model: llm.chatModel,
      });
    }
  }

  async testLocalModel() {
    const llm = this.llmConfig();
    try {
      const reply = await this.llmReply(llm, {
        system: 'You are a connectivity test. Reply with a short OK.',
        messages: [{ role: 'user', content: 'Confirm Finora can reach this model.' }],
        timeoutMs: 30_000,
        maxTokens: 24,
      });
      return {
        ok: true,
        provider: llm.provider,
        model: llm.chatModel,
        baseUrl: llm.baseUrl,
        local: llm.local,
        reply,
      };
    } catch (error) {
      if (error instanceof ModelNotDownloadedError) {
        throw new AppError('invalid_input', error.message, { provider: llm.provider, reason: 'needs_download' });
      }
      const message = error instanceof Error ? error.message : 'The configured model request failed';
      throw new AppError('external_service', `LLM connection failed: ${message}`, {
        provider: llm.provider,
        model: llm.chatModel,
      });
    }
  }

  // Tests the built-in local model directly through the in-process engine, so the
  // Settings flow can verify it works BEFORE the provider is saved (unlike
  // testLocalModel, which tests whatever provider is currently persisted).
  async testBuiltinModel(modelId?: string) {
    const model = getBuiltinModel(modelId);
    try {
      const reply = await this.localModel.generateReply(
        {
          system: 'You are a connectivity test. Reply with a short OK.',
          messages: [{ role: 'user', content: 'Confirm Finora can reach this model.' }],
          timeoutMs: 60_000,
          maxTokens: 24,
          // A connectivity check doesn't need reasoning; disabling it keeps the test
          // fast and avoids a reasoning model spending the tiny budget inside <think>
          // and returning an empty response.
          disableThinking: true,
        },
        model.id,
      );
      return { ok: true, provider: 'builtin', model: model.id, local: true, reply };
    } catch (error) {
      if (error instanceof ModelNotDownloadedError) {
        throw new AppError('invalid_input', error.message, { provider: 'builtin', reason: 'needs_download' });
      }
      const message = error instanceof Error ? error.message : 'The built-in model request failed';
      throw new AppError('external_service', `LLM connection failed: ${message}`, { provider: 'builtin', model: model.id });
    }
  }

  async getLlmStatus() {
    const llm = this.llmConfig();
    return {
      effective: {
        provider: llm.provider,
        label: llm.label,
        baseUrl: llm.baseUrl,
        model: llm.model,
        chatModel: llm.chatModel,
        needsKey: llm.needsKey,
        keySet: llm.keySet,
        local: llm.local,
      },
      providers: LLM_PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl || '',
        needsKey: provider.needsKey,
        defaultModel: provider.defaultModel,
        defaultChatModel: provider.defaultChatModel,
        local: Boolean(provider.local),
      })),
      builtinModels: await this.localModel.statusAll(),
    };
  }

  getBuiltinModelStatus(modelId?: string) {
    return this.localModel.status(modelId);
  }

  downloadBuiltinModel(modelId?: string) {
    return this.localModel.startDownload(modelId);
  }

  cancelBuiltinModelDownload(modelId?: string) {
    return this.localModel.cancelDownload(modelId);
  }

  deleteBuiltinModel(modelId?: string) {
    return this.localModel.deleteModel(modelId);
  }

  // Free disk by keeping only the chosen (just-saved) built-in model's weights.
  // Returns the refreshed status of every model so the caller can re-render.
  async pruneBuiltinModels(keepModelId?: string) {
    await this.localModel.pruneOtherModels(keepModelId);
    return { models: await this.localModel.statusAll() };
  }

  async importCreditReport(input: { filename: string; content: Uint8Array }) {
    const filename = requireText(input.filename, 'filename');
    if (!/\.pdf$/i.test(filename)) {
      throw new AppError('unsupported_format', 'Credit reports must be uploaded as PDF files from a credit bureau');
    }
    if (input.content.byteLength < 5) {
      throw new AppError('invalid_input', 'Credit report PDF is empty');
    }
    const signature = Buffer.from(input.content.slice(0, 5)).toString('utf8');
    if (signature !== '%PDF-') {
      throw new AppError('unsupported_format', 'Credit report upload must be a valid PDF');
    }
    const contentHash = createHash('sha256').update(input.content).digest('hex');
    const existing = this.repository.listCreditReports().find((report) => report.contentHash === contentHash);
    if (existing) return { ok: true, status: 'duplicate', report: existing, ...this.getCreditOverview() };

    let extracted = await extractCreditReport(input.content, filename);
    // Best-effort LLM verify + unknown-format fallback: recovers missed rows and handles
    // layouts no deterministic extractor knows. Runs only when a model is configured/ready;
    // grounded and non-blocking (failures leave the deterministic result untouched). Runs
    // before the empty-check so a fully-unrecognized report can still be salvaged.
    let aiReview: CreditAiReview | null = null;
    const llm = this.llmConfig();
    const modelReady = llm.provider === 'builtin' ? await this.localModel.weightsPresent(llm.model) : llm.keySet;
    if (modelReady) {
      const enriched = await enrichCreditExtractionWithLlm(
        extracted,
        extracted.text,
        (request) => this.llmReply(llm, request),
        { provider: llm.provider, model: llm.chatModel, now: new Date().toISOString() },
      );
      extracted = enriched.extraction;
      aiReview = enriched.aiReview;
    }
    if (extracted.accounts.length === 0 && extracted.inquiries.length === 0 && !extracted.score) {
      throw new AppError(
        'invalid_input',
        'No credit report fields were found. Upload a text-searchable credit bureau PDF, not a scanned image.',
        { reason: 'needs_text_pdf' },
      );
    }
    const totals = summarizeCreditExtraction(extracted);
    const report = this.repository.saveCreditReport({
      filename,
      contentHash,
      bureau: extracted.bureau,
      reportDate: extracted.reportDate,
      score: extracted.score,
      scoreModel: extracted.scoreModel,
      utilizationPercent: totals.utilizationPercent,
      totalBalanceMinor: totals.totalBalanceMinor,
      totalLimitMinor: totals.totalLimitMinor,
      accounts: extracted.accounts.length,
      openAccounts: extracted.accounts.filter((account) => account.isOpen).length,
      delinquentAccounts: extracted.accounts.filter((account) => account.isNegative).length,
      collections: extracted.accounts.filter((account) => /collection/i.test(account.status || '')).length,
      inquiries: extracted.inquiries.filter((inquiry) => inquiry.type === 'hard').length,
      publicRecords: 0,
      raw: {
        accounts: extracted.accounts,
        inquiries: extracted.inquiries,
        suggestions: extracted.suggestions,
        textSample: extracted.textSample,
        ...(aiReview ? { aiReview } : {}),
      },
      bytes: input.content.byteLength,
    });
    return {
      ok: true,
      filename,
      contentHash,
      bytes: input.content.byteLength,
      status: 'processed',
      report,
      ...this.getCreditOverview(),
    };
  }

  generateCreditDisputeLetter(input: { creditor?: string | undefined; accountMask?: string | null | undefined; reason?: string | undefined; bureau?: string | undefined }) {
    const overview = this.getCreditOverview();
    const bureau = normalizeBureau(input.bureau || overview.latest?.bureau || 'credit bureau') || 'credit bureau';
    const creditor = requireText(input.creditor || 'Creditor name', 'creditor');
    const reason = requireText(input.reason || 'I believe this information is inaccurate or incomplete.', 'reason');
    const accountMask = input.accountMask ? ` ${input.accountMask}` : '';
    const today = new Date().toISOString().slice(0, 10);
    const address = bureauDisputeAddress(bureau);
    const letter = [
      `${today}`,
      '',
      `${titleCase(bureau)} Dispute Department`,
      address,
      '',
      'Re: FCRA Section 611 dispute request',
      '',
      'To whom it may concern:',
      '',
      `I am writing to dispute information in my credit file related to ${creditor}${accountMask}.`,
      `Reason for dispute: ${reason}`,
      '',
      'Please conduct a reasonable reinvestigation under FCRA Section 611 and send me the results in writing. If the disputed information cannot be verified as accurate and complete, please delete or correct it.',
      '',
      'I have enclosed copies of documents supporting my position. This template is for my review and editing only, and I understand Finora does not send disputes for me.',
      '',
      'Sincerely,',
      '',
      '[Your name]',
      '[Your mailing address]',
    ].join('\n');
    return { bureau, creditor, accountMask: input.accountMask || null, letter };
  }

  importStatement(input: ImportStatementInput): ImportRecord {
    const account = this.getAccount(input.accountId);
    const filename = requireText(input.filename, 'filename');
    if (input.content.byteLength === 0) {
      throw new AppError('invalid_input', 'Statement content is empty');
    }

    const contentHash = createHash('sha256').update(input.content).digest('hex');
    const existing = this.repository.findImport(account.id, contentHash);
    if (existing) return existing;

    const parser = this.selectParser(filename, input.content, input.format);
    let parsed: TransactionInput[];
    try {
      parsed = parser.parse(input.content, { currency: account.currency, filename });
    } catch (error) {
      throw asAppError(error);
    }
    if (parsed.length === 0) {
      throw new AppError('invalid_input', 'The statement contains no transactions');
    }

    const transactions = parsed.map((transaction) => {
      assertIsoDate(transaction.date);
      assertMinorAmount(transaction.amountMinor);
      const normalized: TransactionInput = {
        date: transaction.date,
        description: requireText(transaction.description, 'description'),
        amountMinor: transaction.amountMinor,
        ...(transaction.sourceId !== undefined ? { sourceId: transaction.sourceId } : {}),
        ...(transaction.category !== undefined ? { category: transaction.category } : {}),
        ...(transaction.pending !== undefined ? { pending: transaction.pending } : {}),
        ...(transaction.metadata !== undefined ? { metadata: transaction.metadata } : {}),
      };
      return { ...normalized, fingerprint: this.fingerprint(account.id, normalized) };
    });

    const record = this.repository.saveImport({
      account,
      filename,
      format: parser.format,
      contentHash,
      transactions,
    });
    // New transactions may create or reshape recurring series and introduce new
    // merchants; refresh both caches in the background (no-op without a model).
    // Fire-and-forget so import stays synchronous; the recurring endpoint also
    // refreshes on read.
    void this.refreshRecurringClassifications().catch((error) => {
      console.warn('Finora recurring classification refresh failed:', error instanceof Error ? error.message : error);
    });
    void this.refreshMerchantIdentities().catch((error) => {
      console.warn('Finora merchant identity refresh failed:', error instanceof Error ? error.message : error);
    });
    return record;
  }

  close(): void {
    this.telegramGateway.stop();
    if (this.alertKick) clearTimeout(this.alertKick);
    if (this.alertTimer) clearInterval(this.alertTimer);
    if (this.providerSyncKick) clearTimeout(this.providerSyncKick);
    if (this.providerSyncTimer) clearInterval(this.providerSyncTimer);
    // Clear the reflection timers too, otherwise a pending pass can fire after
    // close() and call runReflection() against an already-closed repository.
    if (this.reflectionKick) clearTimeout(this.reflectionKick);
    if (this.reflectionTimer) clearInterval(this.reflectionTimer);
    if (this.ruleFeedKick) clearTimeout(this.ruleFeedKick);
    if (this.ruleFeedTimer) clearInterval(this.ruleFeedTimer);
    void this.localModel.unload();
    this.repository.close();
  }

  private telegramToken(): string | null {
    return this.repository.getAppSetting('TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN || null;
  }

  private async replyToTelegram(text: string): Promise<string> {
    const chatId = this.repository.getAppSetting('TELEGRAM_CHAT_ID') || 'owner';
    const sessionKey = `telegram:${chatId}`;
    const command = text.trim().replace(/@\w+$/, '').toLowerCase();

    if (command === '/help' || command === '/start') {
      return 'Ask a question about the accounts, transactions, holdings, balances, rules, or insights stored in Finora. Send /reset to start a fresh conversation.';
    }

    const now = new Date();
    if (command === '/reset' || command === '/new' || command === '/clear') {
      this.repository.saveChatSession(this.freshChatSession(sessionKey, now));
      return 'Started a fresh conversation. ✨';
    }

    // Reuse the persisted session so the conversation survives backend restarts.
    // Start fresh on first contact or once it has crossed the daily 04:00
    // rollover; length within a session is bounded by that daily boundary (and
    // future compaction), not a fixed turn cap.
    let session = this.repository.getChatSession(sessionKey);
    if (!session || new Date(session.startedAt).getTime() < dailyResetBoundary(now).getTime()) {
      session = this.freshChatSession(sessionKey, now);
    }

    const messages: ChatMessage[] = [...session.messages, { role: 'user', content: text }];
    const result = await this.chat(messages, 'telegram');
    this.repository.saveChatSession({
      ...session,
      lastInteractionAt: now.toISOString(),
      messages: [...messages, { role: 'assistant', content: result.reply }],
    });
    return result.reply;
  }

  private freshChatSession(sessionKey: string, now: Date): ChatSessionRecord {
    const iso = now.toISOString();
    return { sessionKey, sessionId: randomUUID(), startedAt: iso, lastInteractionAt: iso, messages: [] };
  }

  private selectParser(filename: string, content: Uint8Array, requested?: string): StatementParser {
    if (requested && requested !== 'auto') {
      const parser = this.parsers.find((candidate) => candidate.format === requested);
      if (!parser) {
        throw new AppError('unsupported_format', `Unsupported statement format: ${requested}`);
      }
      return parser;
    }
    const parser = this.parsers.find((candidate) => candidate.supports(filename, content));
    if (!parser) {
      const extension = extname(filename).toLowerCase() || 'unknown';
      throw new AppError('unsupported_format', `Unsupported statement format: ${extension}`);
    }
    return parser;
  }

  private fingerprint(accountId: string, transaction: TransactionInput): string {
    const identity = transaction.sourceId
      ? `source:${transaction.sourceId}`
      : [transaction.date, transaction.amountMinor, transaction.description.trim().toLowerCase()].join('|');
    return createHash('sha256').update(`${accountId}|${identity}`).digest('hex');
  }

  private llmConfig() {
    return resolveLlmConfig((key) => this.repository.getAppSetting(key));
  }

  // Single entry point for a chat completion: the built-in local model runs
  // in-process through the engine, every other provider goes over the HTTP
  // gateway. Callers stay provider-agnostic.
  private async llmReply(config: ReturnType<typeof this.llmConfig>, input: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    timeoutMs?: number;
    maxTokens?: number;
    // Only honored by the built-in engine (reasoning models); ignored by HTTP providers.
    disableThinking?: boolean;
  }): Promise<string> {
    // Single choke point for context sizing: clamp the prompt to the active provider's window
    // so no provider silently truncates (Ollama) or hard-errors (builtin) on oversized input.
    const contextTokens = config.provider === 'builtin'
      ? await this.localModel.contextBudget(config.model)
      : providerContextTokens(config);
    const clamped = clampChatInput(input, contextTokens);
    if (clamped.truncated) {
      console.warn(`LLM input clamped to fit ${config.provider} context (~${contextTokens} tokens)`);
    }
    const request = { ...input, system: clamped.system, messages: clamped.messages };
    if (config.provider === 'builtin') {
      return this.localModel.generateReply(request, config.model);
    }
    return generateChatReply({ config, ...request });
  }

  private async inferRuleWithModel(text: string, fallback: ReturnType<typeof inferRule>) {
    const llm = this.llmConfig();
    try {
      const reply = await this.llmReply(llm, {
        system: [
          'Infer rule delivery settings for Finora.',
          'Return only compact JSON with keys: scope, cadence.',
          'Allowed scope values: banking, brokerage, credit, all.',
          'Allowed cadence values: event, hourly, daily, weekly, monthly.',
        ].join('\n'),
        messages: [{ role: 'user', content: text }],
        timeoutMs: 1_500,
        maxTokens: 80,
      });
      const parsed = parseRuleInference(reply);
      return {
        kind: fallback.kind,
        scope: normalizeChoice(parsed.scope || fallback.scope, ['banking', 'brokerage', 'credit', 'all'], fallback.scope),
        cadence: normalizeChoice(parsed.cadence || fallback.cadence, ['event', 'hourly', 'daily', 'weekly', 'monthly'], fallback.cadence),
        channel: 'auto',
        inference: { source: 'llm', provider: llm.provider, model: llm.chatModel },
      };
    } catch {
      return { ...fallback, inference: { source: 'heuristic' } };
    }
  }

  // ── Recurring classification ───────────────────────────────────────────────
  // Whether recurring detection can run at all. An injected classifier (tests)
  // counts as ready; otherwise a real model must be configured — a keyed remote
  // provider, or the built-in model with weights downloaded and engine present.
  async recurringModelReady(): Promise<boolean> {
    if (this.recurringClassifierInjected) return true;
    const llm = this.llmConfig();
    // Presence only — a cheap fs check, not the native-engine load status() does.
    // If weights exist but the engine can't run, the classifier call fails and is
    // caught, leaving prior verdicts untouched.
    if (llm.provider === 'builtin') return this.localModel.weightsPresent(llm.model);
    return llm.keySet;
  }

  // Re-classify only the candidate series whose shape changed since last time, so
  // the model is called sparingly. No-op (skipped) when no model is available.
  async refreshRecurringClassifications(): Promise<{ classified: number; skipped: boolean }> {
    if (!(await this.recurringModelReady())) return { classified: 0, skipped: true };
    const candidates = this.repository.listRecurringCandidates();
    if (candidates.length === 0) return { classified: 0, skipped: false };
    const stored = new Map(this.repository.listRecurringClassifications().map((row) => [recurringKey(row), row]));
    const stale = candidates.filter((candidate) => stored.get(recurringKey(candidate))?.signature !== recurringSignature(candidate));
    if (stale.length === 0) return { classified: 0, skipped: false };

    const verdicts = new Map((await this.recurringClassifier(stale)).map((verdict) => [recurringKey(verdict), verdict]));
    const now = new Date().toISOString();
    let classified = 0;
    for (const candidate of stale) {
      const verdict = verdicts.get(recurringKey(candidate));
      if (!verdict) continue;
      const isRecurring = verdict.isRecurring && !violatesFixedFeeBackstop(verdict, candidate);
      this.repository.upsertRecurringClassification({
        merchant: candidate.merchant,
        direction: candidate.direction,
        isRecurring,
        kind: isRecurring ? verdict.kind : null,
        cadence: verdict.cadence,
        canonicalName: verdict.canonicalName,
        confidence: verdict.confidence,
        signature: recurringSignature(candidate),
        updatedAt: now,
      });
      classified += 1;
    }
    return { classified, skipped: false };
  }

  // ── Merchant identity (F1) ─────────────────────────────────────────────────
  // Whether merchant identity resolution can run — an injected identifier (tests)
  // counts, otherwise a real model must be configured. Same shape as
  // recurringModelReady; the two are independent seams.
  async merchantModelReady(): Promise<boolean> {
    if (this.merchantIdentifierInjected) return true;
    const llm = this.llmConfig();
    if (llm.provider === 'builtin') return this.localModel.weightsPresent(llm.model);
    return llm.keySet;
  }

  // Resolve each not-yet-identified merchant to its canonical vendor and cache the
  // verdict, so rules can group by vendor across differing billing descriptions.
  // Only new merchants are sent (identity of a normalized merchant is stable), so
  // the model is called sparingly. No-op when no model is available.
  async refreshMerchantIdentities(): Promise<{ identified: number; skipped: boolean }> {
    if (!(await this.merchantModelReady())) return { identified: 0, skipped: true };
    const candidates = this.repository.listMerchantCandidates();
    if (candidates.length === 0) return { identified: 0, skipped: false };
    const stored = new Map(this.repository.listMerchantIdentities().map((row) => [row.merchant, row]));
    const signature = merchantSignature();
    const stale = candidates.filter((candidate) => stored.get(candidate.merchant)?.signature !== signature);
    if (stale.length === 0) return { identified: 0, skipped: false };

    const verdicts = new Map((await this.merchantIdentifier(stale)).map((verdict) => [verdict.merchant, verdict]));
    const now = new Date().toISOString();
    let identified = 0;
    for (const candidate of stale) {
      const verdict = verdicts.get(candidate.merchant);
      if (!verdict) continue;
      const canonicalName = verdict.canonicalName.trim() || candidate.label;
      this.repository.upsertMerchantIdentity({
        merchant: candidate.merchant,
        canonicalName,
        canonicalSlug: merchantSlug(canonicalName),
        confidence: verdict.confidence,
        signature,
        updatedAt: now,
      });
      identified += 1;
    }
    return { identified, skipped: false };
  }

  // Default identifier: the model maps each normalized merchant to its real-world
  // vendor using brand knowledge. Chunked so every candidate gets a complete
  // verdict; a failed chunk yields no verdicts, leaving prior identities untouched.
  private async identifyMerchantsWithModel(candidates: MerchantCandidate[]): Promise<MerchantIdentityVerdict[]> {
    const CHUNK = 40;
    const verdicts: MerchantIdentityVerdict[] = [];
    for (let start = 0; start < candidates.length; start += CHUNK) {
      verdicts.push(...(await this.identifyMerchantChunk(candidates.slice(start, start + CHUNK))));
    }
    return verdicts;
  }

  private async identifyMerchantChunk(candidates: MerchantCandidate[]): Promise<MerchantIdentityVerdict[]> {
    if (candidates.length === 0) return [];
    const llm = this.llmConfig();
    const payload = candidates.map((candidate, ref) => ({
      ref,
      merchant: candidate.merchant,
      name: candidate.label,
      category: candidate.category || 'unknown',
      count: candidate.count,
    }));
    try {
      const reply = await this.llmReply(llm, {
        system: MERCHANT_IDENTIFIER_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
        timeoutMs: 120_000,
        maxTokens: Math.min(4_000, 300 + candidates.length * 40),
      });
      return parseMerchantVerdicts(reply, candidates);
    } catch {
      return [];
    }
  }

  // Feeds the Recurring table. Requires a model; when none is configured it does
  // not guess — it tells the client to route the user to model settings.
  async listRecurring(): Promise<
    | { status: 'model_required'; provider: string; needsDownload: boolean }
    | { status: 'ok'; items: RecurringListItem[] }
  > {
    if (!(await this.recurringModelReady())) {
      const llm = this.llmConfig();
      return { status: 'model_required', provider: llm.provider, needsDownload: llm.provider === 'builtin' };
    }
    await this.refreshRecurringClassifications();
    const verdicts = new Map(this.repository.listRecurringClassifications().map((row) => [recurringKey(row), row]));

    // Keep only the candidate groups the model called recurring, then merge them
    // by the model's canonical payee name (case-insensitive) + direction, so the
    // many raw descriptions one payee bills under collapse into a single row.
    const recurring = this.repository.listRecurringCandidates()
      .map((candidate) => ({ candidate, verdict: verdicts.get(recurringKey(candidate)) }))
      .filter((entry): entry is { candidate: RecurringCandidate; verdict: RecurringClassification } => Boolean(entry.verdict?.isRecurring));

    const allIds = recurring.flatMap((entry) => entry.candidate.recordIds);
    const txById = new Map(this.repository.listTransactionsByIds(allIds).map((tx) => [tx.id, tx]));

    const groups = new Map<string, { verdicts: RecurringClassification[]; direction: RecurringDirection; category: string | null; currency: string; transactions: RecurringTransaction[] }>();
    for (const { candidate, verdict } of recurring) {
      const key = canonicalMergeKey(candidate.direction, verdict.canonicalName || candidate.label, candidate.merchant);
      const group = groups.get(key) ?? { verdicts: [], direction: candidate.direction, category: candidate.category, currency: candidate.currency, transactions: [] };
      group.verdicts.push(verdict);
      if (!group.category) group.category = candidate.category;
      for (const id of candidate.recordIds) {
        const tx = txById.get(id);
        if (tx) group.transactions.push({ id: tx.id, date: tx.date, description: tx.description, amountMinor: tx.amountMinor, currency: tx.currency, accountId: tx.accountId });
      }
      groups.set(key, group);
    }

    const items: RecurringListItem[] = [...groups.values()]
      .map((group) => {
        const transactions = dedupeById(group.transactions).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
        const best = group.verdicts.slice().sort((a, b) => b.confidence - a.confidence)[0]!;
        const amounts = transactions.map((tx) => Math.abs(tx.amountMinor));
        const amountMinor = median(amounts);
        const dates = transactions.map((tx) => tx.date);
        const periodsPerYear = estimatePeriodsPerYear(dates);
        // Cadence is derived from the observed gaps, not the model's guess: the
        // model only decides whether a series is recurring (best.cadence is left
        // in the classification cache but no longer drives the label).
        return {
          merchant: best.canonicalName || group.verdicts[0]!.merchant,
          direction: group.direction,
          kind: best.kind,
          cadence: deriveCadence(medianGapDays(dates)),
          category: group.category,
          count: transactions.length,
          amountMinor,
          annualMinor: Math.round(amountMinor * periodsPerYear),
          currency: group.currency,
          firstDate: transactions.length ? transactions[transactions.length - 1]!.date : '',
          lastDate: transactions.length ? transactions[0]!.date : '',
          confidence: best.confidence,
          transactions,
        };
      })
      .sort((a, b) => b.annualMinor - a.annualMinor);
    return { status: 'ok', items };
  }

  // Default classifier: the model weighs the merchant name (world knowledge)
  // against the observed cadence, amount, and direction. Candidates are split into
  // small chunks so the model reliably returns a complete, well-formed verdict for
  // every one (a single huge prompt drops fields and truncates). A failed chunk
  // yields no verdicts for its members, leaving their prior cache untouched.
  private async classifyRecurringWithModel(candidates: RecurringCandidate[]): Promise<RecurringVerdict[]> {
    const CHUNK = 25;
    const verdicts: RecurringVerdict[] = [];
    for (let start = 0; start < candidates.length; start += CHUNK) {
      verdicts.push(...(await this.classifyRecurringChunk(candidates.slice(start, start + CHUNK))));
    }
    return verdicts;
  }

  private async classifyRecurringChunk(candidates: RecurringCandidate[]): Promise<RecurringVerdict[]> {
    if (candidates.length === 0) return [];
    const llm = this.llmConfig();
    const payload = candidates.map((candidate, ref) => ({
      ref,
      name: candidate.label,
      flow: candidate.direction === 'in' ? 'money in' : 'money out',
      category: candidate.category || 'unknown',
      count: candidate.count,
      spanDays: Math.round(candidate.spanDays),
      perYear: Math.round(candidate.periodsPerYear),
      typical: Number((candidate.typicalMinor / 100).toFixed(2)),
      range: [Number((candidate.minMinor / 100).toFixed(2)), Number((candidate.maxMinor / 100).toFixed(2))],
      amountVariation: candidate.amountCv == null ? null : Number(candidate.amountCv.toFixed(2)),
      timingVariation: candidate.intervalCv == null ? null : Number(candidate.intervalCv.toFixed(2)),
    }));
    try {
      const reply = await this.llmReply(llm, {
        system: RECURRING_CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
        timeoutMs: 120_000,
        maxTokens: Math.min(4_000, 300 + candidates.length * 80),
      });
      return parseRecurringVerdicts(reply, candidates);
    } catch {
      return [];
    }
  }

  private plaidConnectionsReady(): boolean {
    return this.repository.listProviderConnections().some((connection) =>
      connection.provider === 'plaid' &&
      connection.status !== 'removed' &&
      connection.hasAccessToken
    );
  }

  private snapTradeReady(): boolean {
    return Boolean(
      this.repository.getAppSetting('SNAPTRADE_CLIENT_ID') &&
      this.repository.getAppSetting('SNAPTRADE_CONSUMER_KEY') &&
      this.repository.getAppSetting('SNAPTRADE_USER_ID') &&
      this.repository.getAppSetting('SNAPTRADE_USER_SECRET'),
    );
  }

  private plaidEnvironment(): string {
    return (this.repository.getAppSetting('PLAID_ENV') || process.env.PLAID_ENV || 'production').toLowerCase();
  }

  private plaidClient(): PlaidApi {
    const clientId = this.repository.getAppSetting('PLAID_CLIENT_ID') || process.env.PLAID_CLIENT_ID || '';
    const secret = this.repository.getAppSetting('PLAID_SECRET') || process.env.PLAID_SECRET || '';
    if (!clientId || !secret) {
      throw new AppError('invalid_input', 'Save a Plaid Client ID and secret first.');
    }
    const environment = this.plaidEnvironment();
    const basePath = (PlaidEnvironments[environment as keyof typeof PlaidEnvironments] || PlaidEnvironments.production)!;
    return new PlaidApi(new Configuration({
      basePath,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': clientId,
          'PLAID-SECRET': secret,
        },
      },
    }));
  }

  private snapTradeCredentials(): { clientId: string; consumerKey: string } {
    const clientId = this.repository.getAppSetting('SNAPTRADE_CLIENT_ID') || process.env.SNAPTRADE_CLIENT_ID || '';
    const consumerKey = this.repository.getAppSetting('SNAPTRADE_CONSUMER_KEY') || process.env.SNAPTRADE_CONSUMER_KEY || '';
    if (!clientId || !consumerKey) {
      throw new AppError('invalid_input', 'Save a SnapTrade Client ID and Consumer Key first.');
    }
    return { clientId, consumerKey };
  }

  private snapTradeClient(): Snaptrade {
    return new Snaptrade(this.snapTradeCredentials());
  }

  private accountsForPlaidItem(itemId: string, connection: { institution: string | null; metadata?: Record<string, unknown> | undefined }): Account[] {
    const accountIds = Array.isArray(connection.metadata?.accountIds)
      ? new Set(connection.metadata.accountIds.map((value) => String(value)))
      : new Set<string>();
    const normalizedInstitution = normalizeProviderInstitution(connection.institution || '');
    return this.repository.listAccounts().filter((account) => {
      if (account.source !== 'plaid') return false;
      const metadataItemId = String(account.metadata?.plaidItemId || '');
      if (metadataItemId) return metadataItemId === itemId;
      if (account.providerAccountId && accountIds.has(account.providerAccountId)) return true;
      return normalizedInstitution !== '' && normalizeProviderInstitution(account.institution) === normalizedInstitution;
    });
  }

  private async snapTradeUser(client: Snaptrade): Promise<{ userId: string; userSecret: string }> {
    const savedUserId = this.repository.getAppSetting('SNAPTRADE_USER_ID');
    const savedSecret = this.repository.getAppSetting('SNAPTRADE_USER_SECRET');
    if (savedUserId && savedSecret) return { userId: savedUserId, userSecret: savedSecret };

    let userId = savedUserId || 'finora-local';
    let userSecret = '';
    try {
      const response = await client.authentication.registerSnapTradeUser({ userId });
      userSecret = response.data.userSecret || '';
    } catch {
      const users = await client.authentication.listSnapTradeUsers();
      const first = (users.data || [])[0];
      if (!first) throw new Error('SnapTrade returned no user for these credentials.');
      userId = savedUserId || String(first);
      const reset = await client.authentication.resetSnapTradeUserSecret({ userId, userSecret: savedSecret || '' });
      userSecret = reset.data.userSecret || '';
    }
    if (!userSecret) throw new Error('SnapTrade did not return a user secret.');
    this.repository.saveAppSettings({
      SNAPTRADE_USER_ID: userId,
      SNAPTRADE_USER_SECRET: userSecret,
    });
    return { userId, userSecret };
  }

  private ensureProviderAccount(input: AccountCreate): void {
    const providerAccountId = input.providerAccountId ?? null;
    const existing = this.repository.listAccounts().find((account) =>
      (providerAccountId && account.source === input.source && account.providerAccountId === providerAccountId) ||
      (account.institution === input.institution && account.name === input.name)
    );
    if (existing) return;
    this.createAccount(input);
  }

  private ensureSnapTradeAccount(input: Record<string, any>): Account | null {
    const providerAccountId = String(input.id || '');
    if (!providerAccountId) return null;
    const existing = this.repository.listAccounts().find((account) => account.source === 'snaptrade' && account.providerAccountId === providerAccountId);
    if (existing) return existing;
    const institution = normalizeProviderInstitution(String(input.institution_name || input.brokerage?.name || 'SnapTrade'));
    const name = String(input.name || input.institution_name || 'Brokerage');
    const currency = String(input.balance?.total?.currency || 'USD').toUpperCase();
    this.createAccount({
      institution,
      name,
      type: 'brokerage',
      currency,
      domain: 'brokerage',
      source: 'snaptrade',
      providerAccountId,
      metadata: {
        authorizationId: input.brokerage_authorization || input.authorizationId || null,
        number: input.number || null,
        source: 'snaptrade',
      },
    });
    return this.repository.listAccounts().find((account) => account.source === 'snaptrade' && account.providerAccountId === providerAccountId) || null;
  }

  private chatContext(section?: string) {
    const accounts = this.repository.listAccounts();
    const bankAccounts = accounts.filter((account) => account.domain !== 'brokerage');
    const brokerageAccounts = accounts.filter((account) => account.domain === 'brokerage');
    const transactions = this.repository.listTransactions({ limit: 20 }).items;
    const brokerageTransactions = this.repository.listBrokerageTransactions({ limit: 20 }).items;
    const holdings = this.repository.listBrokerageHoldings().slice(0, 20);
    const balances = this.repository.listAccountBalances();
    const latestBalances = latestByAccount(balances);
    const insights = this.activeFindings();
    return {
      section: section || 'unknown',
      accountCounts: {
        total: accounts.length,
        banking: bankAccounts.length,
        brokerage: brokerageAccounts.length,
      },
      summary: this.repository.summarize({}),
      brokerageSummary: this.repository.summarizeBrokerage(),
      recentBankTransactions: transactions.map((txn) => ({
        date: txn.date,
        description: txn.description,
        account: accounts.find((account) => account.id === txn.accountId)?.name || txn.accountId,
        amountMinor: txn.amountMinor,
        currency: txn.currency,
      })),
      recentBrokerageTransactions: brokerageTransactions.map((txn) => ({
        date: txn.date,
        description: txn.description,
        symbol: txn.symbol,
        account: accounts.find((account) => account.id === txn.accountId)?.name || txn.accountId,
        amountMinor: txn.amountMinor,
        currency: txn.currency,
      })),
      topHoldings: holdings.map((holding) => ({
        symbol: holding.symbol,
        name: holding.name,
        account: accounts.find((account) => account.id === holding.accountId)?.name || holding.accountId,
        valueMinor: holding.valueMinor,
        currency: holding.currency,
      })),
      latestBalances: latestBalances.map((balance) => ({
        account: accounts.find((account) => account.id === balance.accountId)?.name || balance.accountId,
        currentMinor: balance.currentMinor,
        cashMinor: balance.cashMinor,
        buyingPowerMinor: balance.buyingPowerMinor,
        currency: balance.currency,
        asOfDate: balance.asOfDate,
      })),
      insights,
    };
  }

  // Assemble the data the engine reads, evaluate rules, apply mutes, and return
  // findings already ranked by score. The engine is the only place rule logic
  // lives; see docs/rules-design.md.
  private activeFindings(): Finding[] {
    const { findings } = evaluateRules(this.repository.listRules(), this.buildEvaluationData(), (sql, params) => this.repository.runRuleQuery(sql, params));
    const now = Date.now();
    const mutes = this.repository.listFindingMutes().filter((mute) => {
      if (!mute.expiresAt) return true;
      const expires = new Date(mute.expiresAt).getTime();
      return Number.isFinite(expires) && expires > now;
    });
    return findings.filter((finding) => !mutes.some((mute) =>
      (!mute.kind || mute.kind === finding.kind) &&
      (!mute.accountId || mute.accountId === finding.accountId)
    ));
  }

  private buildEvaluationData(): EvaluationData {
    return {
      facts: new Map(this.repository.listFacts().map((fact) => [fact.key, fact])),
      nowMs: Date.now(),
    };
  }

  // Re-derive pending questions from current rules and facts and persist them,
  // keyed by fact so re-evaluation refreshes impact in place. A pending question
  // whose fact is now known is marked answered.
  private refreshQuestions(): QuestionDraft[] {
    const { questions } = evaluateRules(this.repository.listRules(), this.buildEvaluationData(), (sql, params) => this.repository.runRuleQuery(sql, params));
    const openKeys = new Set(questions.map((question) => question.factKey));
    for (const question of questions) {
      this.repository.upsertQuestion({
        factKey: question.factKey,
        prompt: question.prompt,
        ruleKind: question.ruleKind,
        unlockImpactMinor: question.unlockImpactMinor,
        currency: question.currency,
        suggestedValue: question.suggestedValue,
        status: 'pending',
      });
    }
    for (const existing of this.repository.listQuestions('pending')) {
      if (!openKeys.has(existing.factKey) && this.repository.getFact(existing.factKey)) {
        this.repository.updateQuestionStatus(existing.id, 'answered');
      }
    }
    return questions;
  }

}

// Allowed classification values for a rule, mirrored from rules-engine so custom
// rules validate against the same taxonomy.
const RULE_SCOPES = ['banking', 'brokerage', 'credit', 'all'];
const RULE_CADENCES = ['event', 'hourly', 'daily', 'weekly', 'monthly'];
const RULE_DOMAINS = ['banking', 'brokerage', 'credit-report', 'connections'];

// Custom rules expose a single user-facing "Category" — the app's product areas
// (banking / brokerage / credit / all), which is the rule's scope. The internal
// domain (used for the settings-list grouping) is derived from that choice so the
// two classification columns never disagree; there is no separate domain picker.
const SCOPE_TO_DOMAIN: Record<string, RuleDomain> = {
  banking: 'banking',
  brokerage: 'brokerage',
  credit: 'credit-report',
  all: 'banking',
};

// The columns every rule's SQL must SELECT to produce a finding draft (see
// rowToDraft in rules-engine). Optional columns (dollar_impact_minor, currency,
// urgency, effort, severity, action_label, account_id) are not required.
const REQUIRED_RULE_COLUMNS = ['key', 'title', 'detail', 'value', 'confidence', 'evidence_summary', 'evidence_records'];

// The engine's bound-param superset, used to dry-run a candidate rule query during
// validation. Mirrors evaluateRules in rules-engine (values are representative).
const RULE_SQL_VALIDATION_PARAMS: Record<string, unknown> = {
  rule_id: 'preview',
  rule_created_at: '2000-01-01T00:00:00.000Z',
  now_iso: '2000-01-01T00:00:00.000Z',
  now_ms: 946_684_800_000,
  prior_30d_iso: '1999-12-02T00:00:00.000Z',
  hysa_apr: 0.048,
  checking_apr: 0.0001,
};

// The rule-relevant tables/views exposed to the NL→SQL author. The column lists are
// read from the live DB (single source of truth) rather than hand-maintained here, so
// they never drift from the real schema. Internal tables (settings, migrations, chat,
// dashboards, …) are deliberately omitted so the model isn't tempted to query them.
const RULE_SCHEMA_TABLES = [
  'accounts',
  'transactions',
  'account_balances',
  'brokerage_holdings',
  'brokerage_transactions',
  'facts',
  'recurring_series',
  'recurring_classifications',
  'merchant_identities',
  'credit_reports',
];

// Static top of the author system prompt: the task, the strict-JSON contract, and the
// finding-draft output columns. The schema block is injected between header and footer
// at runtime (see ruleAuthorSystemPrompt).
const RULE_SQL_AUTHOR_HEADER = [
  'You author a single deterministic SQLite query for a Finora rule from the user\'s description.',
  'Return ONLY compact JSON: {"sql": string, "category": string, "keywords": string, "title": string}. No prose, no markdown fences.',
  '',
  'The sql MUST be a single read-only SELECT or WITH statement (it runs on a read-only connection; writes fail). No semicolons, no PRAGMA, no attached databases.',
  'It MUST select these columns (a "finding draft"): key (stable unique id per row, TEXT), title, detail, value, confidence (0..1 REAL), evidence_summary, evidence_records (comma-joined record ids, may be \'\').',
  'It MAY also select: dollar_impact_minor (signed integer minor units), currency, urgency (>=1), effort (>=1), severity (\'high\'|\'medium\'|\'low\'), action_label, account_id, created_at.',
  'Amounts are integer minor units (cents); outflows are negative amount_minor. Annualize recurring impact to a 12-month horizon.',
].join('\n');

// Static bottom: UDFs/params, a few dialect one-liners that patch specific local-model
// blind spots (self-repair alone did not fix these), the keep-it-minimal steer, and the
// category values. Kept intentionally short.
const RULE_SQL_AUTHOR_FOOTER = [
  'UDFs/aggregates: money(minor[, currency]) -> display string, normalize_merchant(description), fee_like(description) -> 1/0, median(x).',
  'Bound params you may reference: :now_iso, :now_ms, :prior_30d_iso, :hysa_apr, :checking_apr, :rule_created_at. Use julianday(:now_iso) - julianday(date) for day math. account_balances holds one row per snapshot — take the latest per account with ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of_date DESC, id DESC).',
  '',
  'SQLite syntax (avoid these common mistakes):',
  '- Alias EVERY output column with `expr AS name`. SQLite has NO `:=` operator — never write `name := expr`.',
  '- Qualify EVERY column with its table alias (t.currency, a.name); an unqualified column present in two joined tables fails with "ambiguous column name".',
  '- Compare dates as ISO text (date >= :prior_30d_iso) or via julianday(); never compare a date string to a bare number.',
  '',
  'Keep it MINIMAL: write the simplest query that satisfies the request. Do NOT invent scoring, impact ratios, urgency tiers, or optional columns the user did not ask for. For a "new X" / "any X" rule, just SELECT the matching rows with a stable key — the engine only surfaces rows it has not seen before, so you never compute "new" yourself.',
  '',
  'category must be one of: banking, brokerage, credit, all. keywords is a short lowercase regex-ish phrase for matching. Always add a LIMIT.',
].join('\n');

// Parse the author's JSON reply into a RuleSqlDraft. Returns null when the reply
// has no JSON object or lacks a usable sql string.
// Pull the JSON object out of a model reply, tolerating the wrappers small local
// models add around it: <think> reasoning blocks, ```json fences, and stray prose
// before/after the object. Returns null when no JSON object can be parsed.
function extractJsonObject(reply: string): Record<string, unknown> | null {
  const cleaned = reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // closed reasoning block
    .replace(/<think>[\s\S]*$/i, '')            // unclosed block (budget ran out mid-think)
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1'); // code fences, keep inner text
  for (const text of [cleaned, reply]) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // Try the next candidate (e.g. the raw reply if cleaning mangled it).
    }
  }
  return null;
}

function parseRuleSqlDraft(reply: string): RuleSqlDraft | null {
  const value = extractJsonObject(reply);
  if (!value) return null;
  const sql = typeof value.sql === 'string' ? value.sql.trim() : '';
  if (!sql) return null;
  return {
    sql,
    // The author now returns a single `category` (the app's product areas). `domain`
    // is derived from it downstream (SCOPE_TO_DOMAIN), so any placeholder is fine here.
    domain: 'banking' as RuleDomain,
    scope: String(value.category ?? value.scope ?? 'banking'),
    keywords: typeof value.keywords === 'string' ? value.keywords : '',
    title: typeof value.title === 'string' ? value.title : 'Custom rule',
  };
}

function parseRuleInference(reply: string): Partial<{ scope: string; cadence: string }> {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    const value = JSON.parse(match[0]);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

// ── Recurring classifier helpers ──────────────────────────────────────────────
const RECURRING_KINDS = ['subscription', 'membership', 'bill', 'insurance', 'loan', 'rent', 'income', 'other'];
const RECURRING_CADENCES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'irregular'];

// Deterministic backstop over the model's verdict. A subscription or membership is
// a FIXED periodic fee, so its charges should be about the same size every time;
// if the amounts vary materially it is really discretionary spending (shopping,
// per-use fares) the model mislabeled, so we reject it. Only these two "fixed fee"
// kinds are guarded — bills, insurance, loans, rent, and income legitimately vary.
const FIXED_FEE_KINDS = new Set(['subscription', 'membership']);
const FIXED_FEE_AMOUNT_CV_MAX = 0.4;

function violatesFixedFeeBackstop(verdict: RecurringVerdict, candidate: RecurringCandidate): boolean {
  return (
    FIXED_FEE_KINDS.has(verdict.kind ?? '') &&
    candidate.amountCv != null &&
    candidate.amountCv > FIXED_FEE_AMOUNT_CV_MAX
  );
}

const RECURRING_CLASSIFIER_SYSTEM = [
  'You classify a personal-finance app user\'s merchant transaction series as recurring or not.',
  'Input is a JSON array; each entry is one merchant series with: ref, name, flow ("money out"=you paid, "money in"=you received), category (Plaid-style), count, spanDays, perYear (estimated charges per year), typical (typical amount in dollars), range [min,max], amountVariation (0=identical amounts), timingVariation (0=perfectly regular spacing; null when unknown).',
  '',
  'THE TEST: a series is recurring ONLY if it is a standing agreement that keeps charging (or paying) on a schedule until it is cancelled, closed, or paid off. If you would have to cancel a plan / close an account / finish paying to make it stop, it is recurring. If each occurrence is a fresh, separate decision to buy, it is NOT recurring — no matter how many times it repeats.',
  'RECURRING kinds (essentially only these): subscription (Netflix, Spotify, Oracle Cloud), membership FEE (a fixed periodic access fee like a gym or Costco/Prime — the fee itself, NOT purchases made there), utility/telecom/insurance bill (PG&E, Verizon, Visible, GEICO), rent or mortgage, loan or installment payment to a named lender (Kikoff, Affirm, SoFi), and regular income (payroll, benefits, dividends).',
  'NOT RECURRING = ordinary spending, even when the same merchant appears several times, because each visit is a separate purchase: stores and general merchandise (Target, Dollar Tree, Simon Mall), grocery/markets/convenience (99 Ranch, Safeway, 7-Eleven), restaurants and fast food, coffee, ride-hailing/taxi (Uber, Lyft), gas/fuel, transit fares per ride, travel/hotels, duty-free, ATM, gift-card loads, and one-off or occasional charity donations. Two or three purchases at a shop is NOT a "membership" or "subscription" — do NOT use the membership/subscription label to make ordinary shopping look recurring.',
  'ALSO NOT RECURRING = internal money movement, not a commitment to a third party: transfers between the user\'s own accounts, and paying off / autopaying your own credit-card statement. A generic name like "Payment" / "Payment Thank You" — especially money in, or category LOAN_PAYMENTS with no named lender — is a credit-card statement payment, NOT a loan; mark it isRecurring=false. A loan/installment payment is money out to a NAMED lender and IS recurring.',
  '',
  'Membership/subscription require a fixed access FEE (low amountVariation) on a regular schedule — if the amounts vary from visit to visit, it is shopping, not a membership. When the merchant is a store/market/restaurant/charity and there is no clear standing plan, answer isRecurring=false. When unsure, prefer isRecurring=false; do not stretch to fill the table.',
  'Do not invent product types (no "Gift Card/Subscription"): name the payee as it actually is.',
  '',
  'canonicalName identifies the distinct recurring item. Strip reference codes, transaction ids, store numbers, and location suffixes so charges of the SAME item share the same canonicalName. But treat different products/plans from one brand as DIFFERENT items with different canonicalNames — e.g. a $10 credit-builder and a $35 loan from the same company are two rows, not one. Do not force unrelated charges to share a name; when the typical amount and purpose differ, the canonicalName should differ too.',
  '',
  'Return ONLY a JSON array, one object per input, each: {"ref": <echo>, "isRecurring": bool, "kind": one of subscription|membership|bill|insurance|loan|rent|income|other, "cadence": one of weekly|biweekly|monthly|quarterly|annual|irregular, "canonicalName": clean payee name, "confidence": 0..1}. No prose.',
].join('\n');

function recurringKey(row: { merchant: string; direction: RecurringDirection }): string {
  return `${row.direction}|${row.merchant}`;
}

// Rows merge only when the model gives them the SAME canonical item name (case-
// insensitive), so identity is entirely the model's call — no hardcoded brand
// rules. Same item under varying reference codes → one row; different products
// from one brand (different names) → separate rows.
function canonicalMergeKey(direction: RecurringDirection, canonicalName: string, rawMerchant: string): string {
  const name = canonicalName.trim().toLowerCase();
  return name ? `${direction}|${name}` : `${direction}|raw:${rawMerchant}`;
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row);
  return [...seen.values()];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// Charges per year implied by the merged series' date span. Clamped to [1, 52];
// falls back to monthly when there is only one charge to measure.
function estimatePeriodsPerYear(dates: string[]): number {
  if (dates.length < 2) return 12;
  const times = dates.map((date) => Date.parse(date)).filter((ms) => !Number.isNaN(ms)).sort((a, b) => a - b);
  if (times.length < 2) return 12;
  const spanDays = (times[times.length - 1]! - times[0]!) / 86_400_000;
  if (spanDays <= 0) return 365;
  // Bound at daily (365/yr). The old 52/yr (weekly) ceiling made a daily series
  // (e.g. a transit fare) annualize as weekly and read as "weekly" downstream.
  return Math.max(1, Math.min(365, 365 / (spanDays / (times.length - 1))));
}

// Median number of days between consecutive charges — the factual basis for the
// cadence label. Returns null when there are too few dates to measure a gap.
function medianGapDays(dates: string[]): number | null {
  const times = dates.map((date) => Date.parse(date)).filter((ms) => !Number.isNaN(ms)).sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) gaps.push((times[index]! - times[index - 1]!) / 86_400_000);
  return median(gaps);
}

// Cadence is a computable fact — derive it from the observed median gap rather
// than asking the model to name it. Buckets are centered on the common billing
// rhythms with generous tolerances (a "monthly" bill drifts a few days).
function deriveCadence(gapDays: number | null): string {
  if (gapDays == null) return 'irregular';
  if (gapDays <= 2) return 'daily';
  if (gapDays <= 10) return 'weekly';
  if (gapDays <= 20) return 'biweekly';
  if (gapDays <= 45) return 'monthly';
  if (gapDays <= 100) return 'quarterly';
  if (gapDays <= 250) return 'semiannual';
  return 'yearly';
}

// Bump when the classifier prompt or candidate shape changes so every cached
// verdict is recomputed — the signature embeds it, so a version change makes all
// rows stale at once.
const RECURRING_CLASSIFIER_VERSION = 8;

// The series shape at classification time. When it changes materially — a new
// count bucket or a ~$5 shift in the typical amount — the row is re-classified;
// otherwise the cached verdict stands and no model call is made.
function recurringSignature(candidate: RecurringCandidate): string {
  const countBucket = candidate.count < 3 ? String(candidate.count) : candidate.count < 6 ? '3-5' : candidate.count < 12 ? '6-11' : '12+';
  const amountBucket = Math.round(candidate.typicalMinor / 500);
  return `v${RECURRING_CLASSIFIER_VERSION}|${countBucket}|${amountBucket}`;
}

function parseRecurringVerdicts(reply: string, candidates: RecurringCandidate[]): RecurringVerdict[] {
  const match = reply.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const verdicts: RecurringVerdict[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const ref = Number((entry as Record<string, unknown>).ref);
    const candidate = candidates[ref];
    if (!candidate) continue;
    const record = entry as Record<string, unknown>;
    const isRecurring = Boolean(record.isRecurring);
    verdicts.push({
      merchant: candidate.merchant,
      direction: candidate.direction,
      isRecurring,
      kind: isRecurring ? normalizeChoice(String(record.kind ?? 'other'), RECURRING_KINDS, 'other') : null,
      cadence: normalizeChoice(String(record.cadence ?? 'irregular'), RECURRING_CADENCES, 'irregular'),
      canonicalName: record.canonicalName ? String(record.canonicalName).slice(0, 60) : candidate.label,
      confidence: Math.max(0, Math.min(1, Number(record.confidence))) || 0,
    });
  }
  return verdicts;
}

// ── Merchant identity (F1) ─────────────────────────────────────────────────────
const MERCHANT_IDENTIFIER_SYSTEM = [
  'You resolve a personal-finance app user\'s merchant descriptions to a canonical vendor identity.',
  'Input is a JSON array; each entry is one normalized merchant with: ref, merchant (a normalized key), name (a representative raw description), category (Plaid-style), count.',
  '',
  'For each, return the real-world vendor it belongs to. Merchants that are the SAME company under different billing descriptors — e.g. "APPLE.COM/BILL", "ITUNES", "APPLE SERVICES" — must share ONE canonicalName. Distinct vendors must get distinct names. Use world knowledge of brands.',
  'Do NOT over-merge: a payment-processor prefix (SQ *, TST*, PP*, PAYPAL *) is not the vendor — name the actual seller after it. Unrelated merchants that merely look similar must stay separate. When unsure, keep the merchant as its own identity, using a cleaned version of its name.',
  '',
  'Return ONLY a JSON array, one object per input, each: {"ref": <echo>, "canonicalName": clean vendor name, "confidence": 0..1}. No prose.',
].join('\n');

// Bump when the prompt or candidate shape changes so every cached identity is
// recomputed. Identity of a fixed normalized merchant is otherwise stable, so a
// merchant is classified exactly once between version bumps.
const MERCHANT_IDENTIFIER_VERSION = 1;

function merchantSignature(): string {
  return `v${MERCHANT_IDENTIFIER_VERSION}`;
}

// The lowercased, whitespace-collapsed join key shared by every merchant that
// maps to the same canonical vendor name.
function merchantSlug(canonicalName: string): string {
  return canonicalName.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseMerchantVerdicts(reply: string, candidates: MerchantCandidate[]): MerchantIdentityVerdict[] {
  const match = reply.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const verdicts: MerchantIdentityVerdict[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const ref = Number(record.ref);
    const candidate = candidates[ref];
    if (!candidate) continue;
    const canonicalName = record.canonicalName ? String(record.canonicalName).slice(0, 60).trim() : candidate.label;
    verdicts.push({
      merchant: candidate.merchant,
      canonicalName: canonicalName || candidate.label,
      canonicalSlug: merchantSlug(canonicalName || candidate.label),
      confidence: Math.max(0, Math.min(1, Number(record.confidence))) || 0,
    });
  }
  return verdicts;
}

// Parse and validate a rule-feed document into specs, throwing AppError on a
// malformed feed. Each spec is coerced with safe defaults so the feed format can
// grow additively; the caller stamps source = 'downloaded'. Deliberately hand-rolled
// (not zod) to match the application layer's dependency-free style.
function parseRuleFeed(body: string): { version: number; specs: RuleSpec[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new AppError('invalid_input', 'Rule feed is not valid JSON.');
  }
  if (!doc || typeof doc !== 'object') throw new AppError('invalid_input', 'Rule feed must be an object.');
  const record = doc as Record<string, unknown>;
  const version = Number(record.version);
  if (!Number.isFinite(version)) throw new AppError('invalid_input', 'Rule feed is missing a numeric version.');
  if (!Array.isArray(record.specs)) throw new AppError('invalid_input', 'Rule feed is missing a specs array.');
  return { version, specs: record.specs.map((raw, index) => coerceRuleSpec(raw, index)) };
}

const RULE_FEED_CLASSES = ['D', 'L', 'L+'];
const RULE_FEED_TIERS = ['observer', 'advisor', 'guardian', 'navigator'];

function coerceRuleSpec(raw: unknown, index: number): RuleSpec {
  if (!raw || typeof raw !== 'object') throw new AppError('invalid_input', `Rule feed spec #${index} is not an object.`);
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === 'string' ? r.kind.trim() : '';
  if (!kind) throw new AppError('invalid_input', `Rule feed spec #${index} is missing a kind.`);
  const pick = (value: unknown, allowed: string[], fallback: string) =>
    (typeof value === 'string' && allowed.includes(value) ? value : fallback);
  const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
  const strOrNull = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    kind,
    domain: pick(r.domain, RULE_DOMAINS, 'banking') as RuleSpec['domain'],
    executionClass: pick(r.executionClass, RULE_FEED_CLASSES, 'D') as RuleSpec['executionClass'],
    actionTier: pick(r.actionTier, RULE_FEED_TIERS, 'observer') as RuleSpec['actionTier'],
    scope: str(r.scope, 'all'),
    cadence: str(r.cadence, 'event'),
    keywords: str(r.keywords, ''),
    sql: strOrNull(r.sql),
    prompt: strOrNull(r.prompt),
    facts: coerceFactNeeds(r.facts),
    enabled: r.enabled !== false,
    source: 'downloaded',
    version: Number.isFinite(Number(r.version)) ? Number(r.version) : 1,
  };
}

function coerceFactNeeds(raw: unknown): RuleFactNeed[] {
  if (!Array.isArray(raw)) return [];
  const needs: RuleFactNeed[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key.trim() : '';
    const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
    if (!key || !prompt) continue;
    const need: RuleFactNeed = {
      key,
      prompt,
      unlockImpactMinor: Number.isFinite(Number(r.unlockImpactMinor)) ? Number(r.unlockImpactMinor) : 0,
    };
    if (typeof r.currency === 'string') need.currency = r.currency;
    if (typeof r.expects === 'string' && ['currency', 'percent', 'number', 'date', 'text'].includes(r.expects)) {
      need.expects = r.expects as FactExpectation;
    }
    needs.push(need);
  }
  return needs;
}

// A human title for a fact-gated rule kind, for the needs-input surface. Known
// kinds get a hand-written label; anything else is titleized from the kind slug.
const FACT_RULE_TITLES: Record<string, string> = {
  'employer-match': 'Employer 401(k) match',
};
function factRuleTitle(kind: string): string {
  return FACT_RULE_TITLES[kind] ?? kind.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// Deterministic normalization/validation of a fact value by expected shape. Returns
// '' when no usable value is present, which the caller treats as a rejected answer.
function normalizeFactScalar(raw: string, expects: FactExpectation): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (expects === 'text') return trimmed.replace(/\s+/g, ' ');
  if (expects === 'date') {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  }
  const match = trimmed.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!match) return '';
  let n = Number(match[0]);
  if (!Number.isFinite(n)) return '';
  if (expects === 'currency') {
    const suffix = trimmed.toLowerCase().match(/\d\s*([km])/)?.[1];
    if (suffix === 'k') n *= 1_000;
    else if (suffix === 'm') n *= 1_000_000;
    return n < 0 ? '' : String(Math.round(n));
  }
  if (expects === 'percent') return n < 0 || n > 100 ? '' : String(n);
  return String(n); // number
}

function formatMinorAmount(amountMinor: number, currency = 'USD'): string {
  const amount = amountMinor / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount);
  } catch {
    return `${currency || 'USD'} ${amount.toFixed(2)}`;
  }
}

function suggestedRuleHour(cadence: string) {
  return cadence === 'event' || cadence === 'hourly' ? null : 9;
}

function plaidAccountDomain(account: { type?: string | null; subtype?: string | null }): string {
  const raw = `${account.type || ''} ${account.subtype || ''}`.toLowerCase();
  if (/investment|brokerage|ira|401k|crypto/.test(raw)) return 'brokerage';
  return 'bank';
}

function normalizeProviderInstitution(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || 'provider';
}

function connectorError(prefix: string, error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError('external_service', `${prefix}: ${message}`);
}

function emptyProviderSyncResult(): ProviderSyncResult {
  return {
    accounts: 0,
    transactions: 0,
    balances: 0,
    holdings: 0,
    modified: 0,
    removed: 0,
    skipped: 0,
    errors: 0,
  };
}

// Plaid Item errors that require the user to re-authenticate through Link update
// mode. Retrying with the same token cannot recover these, so the connection is
// parked until the user reconnects; every other error is treated as transient.
const PLAID_REAUTH_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'ITEM_LOCKED',
  'USER_PERMISSION_REVOKED',
  'USER_ACCOUNT_REVOKED',
  'ACCESS_NOT_GRANTED',
]);

function plaidErrorInfo(error: unknown): { code: string | null; message: string; reauthRequired: boolean } {
  const data = (error as { response?: { data?: { error_code?: string; error_message?: string } } })?.response?.data;
  const code = data?.error_code ?? null;
  const message = data?.error_message || (error instanceof Error ? error.message : String(error));
  return { code, message, reauthRequired: code !== null && PLAID_REAUTH_CODES.has(code) };
}

function toMinor(value: number | string | null | undefined): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function snapTradeSymbol(value: any): { id: string | null; symbol: string | null; description: string | null; securityType: string | null } {
  const nested = value?.symbol && typeof value.symbol === 'object' ? value.symbol : value;
  const symbol = nested?.symbol || nested?.raw_symbol || value?.raw_symbol || null;
  return {
    id: nested?.id ? String(nested.id) : value?.id ? String(value.id) : null,
    symbol: symbol === null || symbol === undefined ? null : String(symbol),
    description: nested?.description || value?.description || null,
    securityType: nested?.type?.description || nested?.type?.code || value?.type?.description || value?.type?.code || null,
  };
}

function plaidInvestmentAmountMinor(transaction: { amount?: unknown; type?: unknown; subtype?: unknown }): number {
  const amount = Math.abs(toMinor(transaction.amount as number | string | null | undefined));
  const kind = `${transaction.type || ''} ${transaction.subtype || ''}`.toLowerCase();
  if (/buy|fee|tax|withdrawal|debit/.test(kind)) return -amount;
  if (/sell|dividend|interest|deposit|credit|cash/.test(kind)) return amount;
  return -toMinor(transaction.amount as number | string | null | undefined);
}

function plaidInvestmentTransactionDate(transaction: { date?: unknown; transaction_datetime?: unknown }): string {
  const datetime = String(transaction.transaction_datetime || '');
  if (/^\d{4}-\d{2}-\d{2}T/.test(datetime)) return datetime.slice(0, 10);
  return String(transaction.date || '').slice(0, 10);
}

function autoSyncEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.AUTO_SYNC || '');
}

function autoSyncHours(): number {
  const hours = Number(process.env.AUTO_SYNC_HOURS || 1);
  return Number.isFinite(hours) ? Math.max(1, hours) : 1;
}

function normalizeChoice(value: string, allowed: string[], fallback: string) {
  const normalized = value.toLowerCase().trim();
  return allowed.includes(normalized) ? normalized : fallback;
}

function latestByAccount<T extends { accountId: string; asOfDate: string }>(items: T[]): T[] {
  const byAccount = new Map<string, T>();
  for (const item of items) {
    const current = byAccount.get(item.accountId);
    if (!current || item.asOfDate > current.asOfDate) byAccount.set(item.accountId, item);
  }
  return [...byAccount.values()];
}

function telegramApiUrl(token: string, method: string): URL {
  const base = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  return new URL(`${base}/bot${token}/${method}`);
}

function telegramChatEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.CHAT_GATEWAY || '');
}

function insightDeliveryEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.ALERTS_ENABLED || '');
}

function parseStringArray(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function insightIdentity(finding: Finding): string {
  return createHash('sha256')
    .update([finding.kind, finding.scope, finding.accountId || '', finding.title].join('|'))
    .digest('hex');
}

const IM_DOMAIN_LABELS: Record<string, string> = {
  banking: 'Banking',
  brokerage: 'Brokerage',
  'credit-report': 'Credit report',
  connections: 'Connections',
};
const IM_DOMAIN_ORDER = ['banking', 'brokerage', 'credit-report', 'connections'];

// Group the delivered findings under their rule-taxonomy category so the message
// reads by domain (Banking, Brokerage, Credit report, Connections).
function formatImInsights(findings: Finding[]): string {
  const icon = { high: '🔴', medium: '🟠', low: '🟡' } as const;
  const byDomain = new Map<string, Finding[]>();
  for (const finding of findings) {
    const domain = finding.domain || 'banking';
    const bucket = byDomain.get(domain);
    if (bucket) bucket.push(finding);
    else byDomain.set(domain, [finding]);
  }
  const orderedDomains = [...IM_DOMAIN_ORDER, ...[...byDomain.keys()].filter((d) => !IM_DOMAIN_ORDER.includes(d))];
  const sections = orderedDomains
    .map((domain) => {
      const items = byDomain.get(domain);
      if (!items || items.length === 0) return '';
      const lines = items.map((finding) => `${icon[finding.severity]} ${finding.title}\n${finding.detail}`);
      return `${(IM_DOMAIN_LABELS[domain] || domain).toUpperCase()}\n${lines.join('\n\n')}`;
    })
    .filter(Boolean);
  return `Finora — ${findings.length} new finding${findings.length === 1 ? '' : 's'}\n\n${sections.join('\n\n')}`;
}

async function extractCreditReport(content: Uint8Array, filename: string): Promise<CreditExtraction> {
  const text = await normalizePdfText(content);
  const bureau = normalizeBureau(filename) || normalizeBureau(text);
  const reportDate = findDate(text, /(report\s+date|date\s+of\s+report|prepared\s+for|as\s+of)\s*:?\s*/i);
  const scoreMatch = /\b(?:fico|vantagescore|credit\s+score|score)\b[^\d]{0,40}([3-8]\d{2})\b/i.exec(text);
  const score = scoreMatch ? Number(scoreMatch[1]) : null;
  const scoreModel = /\b(FICO\s*\d*|VantageScore\s*\d(?:\.\d)?|Credit\s+Score)\b/i.exec(text)?.[1]?.trim() ?? null;
  const accounts = extractExperianTradelines(text).concat(extractEquifaxTradelines(text));
  const inquiries = extractExperianInquiries(text).concat(extractEquifaxInquiries(text));
  const fallbackAccounts = accounts.length ? accounts : extractCreditTradelines(text);
  const fallbackInquiries = inquiries.length ? inquiries : extractCreditInquiries(text);
  return {
    bureau,
    reportDate,
    score: score !== null && score <= 850 ? score : null,
    scoreModel,
    accounts: fallbackAccounts,
    inquiries: fallbackInquiries,
    suggestions: suggestCreditDisputes(fallbackAccounts, fallbackInquiries),
    textSample: text.slice(0, 1200),
    text,
  };
}

// Best-effort LLM pass over a deterministic extraction: it recovers accounts/inquiries the
// bureau/generic extractors missed (verify) and gives us structured output for layouts no
// deterministic extractor recognizes (fallback). Provider-agnostic: `reply` is the caller's
// llmReply. NEVER trusted blindly — every returned entry must be *grounded* (its creditor/
// company appears verbatim, modulo case/punctuation, in the report text) or it is dropped, so
// the model cannot fabricate accounts or inquiries that feed FCRA dispute letters. Deterministic
// entries stay authoritative; the LLM only adds non-duplicate, grounded rows. Any failure or
// timeout returns the input unchanged — enrichment is additive and must not break imports.
export async function enrichCreditExtractionWithLlm(
  extracted: CreditExtraction,
  text: string,
  reply: (input: { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; timeoutMs?: number; maxTokens?: number }) => Promise<string>,
  meta: { provider: string; model: string; now: string },
): Promise<{ extraction: CreditExtraction; aiReview: CreditAiReview | null }> {
  const textNorm = groundKey(text);
  const budget = text.slice(0, 48_000);
  const system = [
    'You extract credit-report data. Output ONLY compact JSON, no prose.',
    'Shape: {"accounts":[{"creditor","accountMask","accountType","status","balance","creditLimit","dateOpened"}],"inquiries":[{"company","inquiryDate","type"}]}.',
    'Copy every value VERBATIM from the report text. Never infer, guess, or invent a value.',
    'If a field is not present, use null. If you are unsure an entry exists, omit it entirely.',
    'Money as the printed string (e.g. "$1,234"); dates as printed; type is "hard" or "soft".',
    'List only real tradelines and inquiries — not headings, explanatory text, or addresses.',
  ].join('\n');
  const user = [
    'Report text:',
    budget,
    '',
    'Already extracted (do not repeat these; only add what is missing):',
    JSON.stringify({
      accounts: extracted.accounts.map((a) => ({ creditor: a.creditor, accountMask: a.accountMask })),
      inquiries: extracted.inquiries.map((q) => ({ company: q.company, inquiryDate: q.inquiryDate })),
    }),
  ].join('\n');

  let parsed: { accounts?: unknown; inquiries?: unknown };
  try {
    const raw = await reply({ system, messages: [{ role: 'user', content: user }], timeoutMs: 60_000, maxTokens: 2_000 });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { extraction: extracted, aiReview: null };
    parsed = JSON.parse(match[0]);
  } catch {
    return { extraction: extracted, aiReview: null };
  }

  const llmAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  const llmInquiries = Array.isArray(parsed.inquiries) ? parsed.inquiries : [];

  const addedAccounts: CreditTradeline[] = [];
  const accountKeys = new Set(extracted.accounts.map(accountKey));
  for (const raw of llmAccounts) {
    const account = coerceLlmAccount(raw, textNorm);
    if (!account) continue;
    const key = accountKey(account);
    if (accountKeys.has(key)) continue;
    accountKeys.add(key);
    addedAccounts.push(account);
  }

  const addedInquiries: CreditInquiry[] = [];
  const inquiryKeys = new Set(extracted.inquiries.map(inquiryKey));
  for (const raw of llmInquiries) {
    const inquiry = coerceLlmInquiry(raw, textNorm);
    if (!inquiry) continue;
    const key = inquiryKey(inquiry);
    if (inquiryKeys.has(key)) continue;
    inquiryKeys.add(key);
    addedInquiries.push(inquiry);
  }

  if (!addedAccounts.length && !addedInquiries.length) return { extraction: extracted, aiReview: null };

  const accounts = extracted.accounts.concat(addedAccounts);
  const inquiries = extracted.inquiries.concat(addedInquiries);
  return {
    extraction: {
      ...extracted,
      accounts,
      inquiries,
      suggestions: suggestCreditDisputes(accounts, inquiries),
    },
    aiReview: {
      provider: meta.provider,
      model: meta.model,
      addedAccounts: addedAccounts.length,
      addedInquiries: addedInquiries.length,
      ranAt: meta.now,
    },
  };
}

// Normalized key for grounding/dedupe: lowercase, alphanumerics only. Lenient enough to match
// across case and PDF line-wrap artifacts ("CONSUMERINF O.COM" vs "CONSUMERINFO.COM"), strict
// enough that a wholly invented name won't be found in the report text.
function groundKey(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function groundedIn(textNorm: string, value: string): boolean {
  const key = groundKey(value);
  return key.length >= 3 && textNorm.includes(key);
}

function accountKey(account: CreditTradeline): string {
  return `${groundKey(account.creditor)}|${(account.accountMask || '').replace(/\D/g, '').slice(-4)}`;
}

function inquiryKey(inquiry: CreditInquiry): string {
  return `${groundKey(inquiry.company)}|${inquiry.inquiryDate || ''}`;
}

function moneyStringToMinor(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/[^0-9.\-]/g, '');
  if (!digits) return null;
  const amount = Number(digits);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function coerceLlmAccount(raw: unknown, textNorm: string): CreditTradeline | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const creditor = typeof item.creditor === 'string' ? item.creditor.trim() : '';
  if (!creditor || !groundedIn(textNorm, creditor)) return null;
  const status = typeof item.status === 'string' ? item.status.trim() : null;
  const accountType = typeof item.accountType === 'string' ? item.accountType.trim() : null;
  return {
    creditor,
    accountMask: typeof item.accountMask === 'string' ? item.accountMask.trim() || null : null,
    accountType,
    status,
    isOpen: !/closed|paid and closed/i.test(status || ''),
    isNegative: /collection|charge[- ]?off|delinquent|late|repossession|foreclosure|derogatory|past due/i.test(status || ''),
    isRevolving: /credit card|revolving|charge/i.test(accountType || ''),
    dateOpened: normalizeDate(typeof item.dateOpened === 'string' ? item.dateOpened : ''),
    dateReported: null,
    balanceMinor: moneyStringToMinor(item.balance),
    creditLimitMinor: moneyStringToMinor(item.creditLimit),
    pastDueMinor: null,
  };
}

function coerceLlmInquiry(raw: unknown, textNorm: string): CreditInquiry | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const company = typeof item.company === 'string' ? item.company.trim() : '';
  if (!company || isInquiryNoiseLine(company) || !groundedIn(textNorm, company)) return null;
  return {
    company,
    inquiryDate: normalizeDate(typeof item.inquiryDate === 'string' ? item.inquiryDate : ''),
    type: item.type === 'soft' ? 'soft' : 'hard',
  };
}

async function normalizePdfText(content: Uint8Array): Promise<string> {
  const pdfText = await extractPdfText(content).catch(() => '');
  if (pdfText.length > 500) return pdfText;
  const raw = Buffer.from(content).toString('latin1');
  const literalText = [...raw.matchAll(/\(([^()]|\\[()nrtbf\\]){2,}\)\s*Tj/g)]
    .map((match) => match[0].replace(/\)\s*Tj$/, '').replace(/^\(/, ''))
    .join('\n');
  const source = literalText.length > 200 ? literalText : raw;
  return source
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\n|\\r/g, '\n')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function extractPdfText(content: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(content),
    useSystemFonts: true,
  }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const text = await page.getTextContent();
    pages.push(text.items.map((item: unknown) => {
      const maybe = item as { str?: unknown };
      return typeof maybe.str === 'string' ? maybe.str : '';
    }).join('\n'));
  }
  return pages.join('\n').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extractExperianTradelines(text: string): CreditTradeline[] {
  if (!/Annual Credit Report - Experian|usa\.experian\.com/i.test(text)) return [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const accounts: CreditTradeline[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^Account Info$/i.test(lines[index]!)) continue;
    const nextInfo = lines.findIndex((line, offset) => offset > index && /^Account Info$/i.test(line));
    const nextBoundary = lines.findIndex((line, offset) =>
      offset > index && /^(Hard Inquiries|Soft Inquiries|Public Records|Personal Information)$/i.test(line)
    );
    const endCandidates = [nextInfo, nextBoundary].filter((value) => value > index);
    const end = endCandidates.length ? Math.min(...endCandidates) : Math.min(lines.length, index + 120);
    const block = lines.slice(index, end);
    const creditor = lineValue(block, 'Account Name');
    if (!creditor) continue;
    const accountType = lineValue(block, 'Account Type');
    const status = lineValue(block, 'Status');
    const balanceMinor = parseMoney(lineValue(block, 'Balance'));
    const creditLimitMinor = parseMoney(lineValue(block, 'Credit Limit'));
    const pastDueMinor = parseMoney(lineValue(block, 'Past Due'));
    const closed = /closed|paid and closed/i.test(status || '') || Boolean(lineValue(block, 'On Record Until'));
    const negative = /collection|charge.?off|delinquent|late|repossession|foreclosure|derogatory/i.test(status || '') ||
      (pastDueMinor !== null && pastDueMinor > 0);
    accounts.push({
      creditor,
      accountMask: maskFromAccountNumber(lineValue(block, 'Account Number')),
      accountType,
      status,
      isOpen: !closed,
      isNegative: negative,
      isRevolving: /credit card|revolving|charge account/i.test(accountType || '') || creditLimitMinor !== null,
      dateOpened: normalizeDate(lineValue(block, 'Date Opened') || ''),
      dateReported: normalizeDate(lineValue(block, 'Balance Updated') || lineValue(block, 'Status Updated') || ''),
      balanceMinor,
      creditLimitMinor,
      pastDueMinor,
    });
  }
  return dedupeCreditAccounts(accounts);
}

// Experian's ACR export lays each inquiry out as:
//   <company name — often wrapped across several lines>
//   Inquired on
//   MM/DD/YYYY            (hard inquiries may list several dates joined by "and"/",")
//   <address lines>
//   <description>         hard: "…scheduled to continue on record until <Month Year>."
//                         soft: a phone number, e.g. "(855) 423-3729"
// The literal "Inquired on" only appears in the inquiry sections, so we scan the whole
// document rather than slicing to a heading — the first "Hard Inquiries" string is a
// table-of-contents anchor, and the real entries sit after a "Soft Inquiries /
// No public records reported." block, so heading-based slicing misses them entirely.
function extractExperianInquiries(text: string): CreditInquiry[] {
  if (!/Annual Credit Report - Experian|usa\.experian\.com/i.test(text)) return [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const inquiries: CreditInquiry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^Inquired on$/i.test(lines[index]!)) continue;

    // First MM/DD/YYYY that follows the "Inquired on" marker (the most recent date).
    let date: string | null = null;
    for (let offset = index + 1; offset < Math.min(index + 4, lines.length); offset += 1) {
      if (/^Inquired on$/i.test(lines[offset]!)) break;
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(lines[offset]!)) {
        date = normalizeDate(lines[offset]!);
        break;
      }
    }

    // Company name: the non-boundary lines immediately preceding "Inquired on".
    const companyParts: string[] = [];
    for (let offset = index - 1; offset >= 0 && companyParts.length < 5; offset -= 1) {
      if (isExperianInquiryBoundary(lines[offset]!)) break;
      companyParts.unshift(lines[offset]!);
    }
    const company = companyParts.join(' ').replace(/\s+/g, ' ').trim();

    // Hard inquiries stay on record; soft inquiries list a phone number instead.
    let type: CreditInquiry['type'] = 'soft';
    for (let offset = index + 1; offset < lines.length; offset += 1) {
      if (/^Inquired on$/i.test(lines[offset]!)) break;
      if (/continue on record/i.test(lines[offset]!)) { type = 'hard'; break; }
      if (/^\(\d{3}\)\s?\d{3}-\d{4}$/.test(lines[offset]!)) { type = 'soft'; break; }
    }

    if (company && date) inquiries.push({ company, inquiryDate: date, type });
  }
  return inquiries;
}

// Lines that cannot be part of a company name when walking backward from "Inquired on":
// dates, "and"/"," joiners, addresses, phone numbers, inquiry descriptions, section
// headings, and Experian's per-page header (timestamp, title, print URL, "18/31").
function isExperianInquiryBoundary(value: string): boolean {
  return /^Inquired on$/i.test(value) ||
    /^\d{2}\/\d{2}\/\d{4}$/.test(value) ||
    /^(and|,)$/i.test(value) ||
    /^\d/.test(value) ||
    /^PO BOX/i.test(value) ||
    /^\(\d{3}\)/.test(value) ||
    /[A-Z]{2},?\s*\d{5}/.test(value) ||
    /(continue on record|on behalf of|this inquiry|real estate|auto loan|credit granting|unspeci|\buntil\b)/i.test(value) ||
    /(Hard Inquiries|Soft Inquiries|No public records|Personal Information|Public Records)/i.test(value) ||
    /(Annual Credit Report|usa\.experian\.com)/i.test(value) ||
    /^\d{1,2}\/\d{1,2}\/\d{2},/.test(value) ||
    /^\d+\/\d+$/.test(value);
}

function extractEquifaxTradelines(text: string): CreditTradeline[] {
  if (!/Equifax Credit Report|EFX-ACR|Confirmation #/i.test(text)) return [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const starts: Array<{ creditorIndex: number; fieldIndex: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/Date Reported:\s*$/i.test(lines[index]!) && !/Date Reported:\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/i.test(lines[index]!)) continue;
    const creditorIndex = findEquifaxCreditorIndex(lines, index);
    if (creditorIndex >= 0) starts.push({ creditorIndex, fieldIndex: index });
  }

  const accounts: CreditTradeline[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = starts[index + 1]?.creditorIndex ?? lines.findIndex((line, offset) =>
      offset > start.fieldIndex && /^(Inquiries|Company Information|Public Records)$/i.test(line)
    );
    const block = lines.slice(start.creditorIndex, end > start.creditorIndex ? end : Math.min(lines.length, start.fieldIndex + 80));
    const rawCreditor = block[0]!;
    const creditor = rawCreditor.replace(/\s+-\s+Closed$/i, '').trim();
    const accountType = equifaxLineValue(block, 'Loan/Account Type');
    const status = equifaxLineValue(block, 'Status');
    const closed = /-\s*Closed$/i.test(rawCreditor) || /Paid and Closed|Closed or Paid Account/i.test(block.join('\n'));
    const pastDueMinor = parseMoney(equifaxLineValue(block, 'Past Due Amount'));
    if (!creditor || isEquifaxMetadataLine(creditor)) continue;
    accounts.push({
      creditor,
      accountMask: maskFromAccountNumber(equifaxLineValue(block, 'Account Number')),
      accountType,
      status,
      isOpen: !closed,
      isNegative: /collection|charge.?off|delinquent|late|repossession|foreclosure|derogatory/i.test(status || '') ||
        (pastDueMinor !== null && pastDueMinor > 0),
      isRevolving: /credit card|revolving|flexible spending/i.test(accountType || '') ||
        parseMoney(equifaxLineValue(block, 'Credit Limit')) !== null,
      dateOpened: normalizeDate(equifaxLineValue(block, 'Date Opened') || ''),
      dateReported: normalizeDate(equifaxLineValue(block, 'Date Reported') || ''),
      balanceMinor: parseMoney(equifaxLineValue(block, 'Balance')),
      creditLimitMinor: parseMoney(equifaxLineValue(block, 'Credit Limit')),
      pastDueMinor,
    });
  }
  return dedupeCreditAccounts(accounts);
}

function extractEquifaxInquiries(text: string): CreditInquiry[] {
  if (!/Equifax Credit Report|EFX-ACR|Confirmation #/i.test(text)) return [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line, index) =>
    /^Company Information$/i.test(line) &&
    /^Inquiry Type$/i.test(lines[index + 1] || '') &&
    /^Inquiry Date\(s\)$/i.test(lines[index + 2] || '')
  );
  if (start < 0) return [];
  const inquiries: CreditInquiry[] = [];
  for (let index = start + 3; index < lines.length; index += 1) {
    const company = lines[index]!;
    if (/^(?:000000001-DISC|Page \d+|Prepared for:|Date:|Confirmation #|Additional Information|Summary of Rights)/i.test(company)) break;
    if (isInquiryNoiseLine(company) || isEquifaxMetadataLine(company)) continue;
    let typeIndex = -1;
    for (let offset = index + 1; offset < Math.min(lines.length, index + 8); offset += 1) {
      if (/^(Hard|Soft)$/i.test(lines[offset]!)) {
        typeIndex = offset;
        break;
      }
    }
    if (typeIndex < 0) continue;
    const inquiryDate = findDate(lines[typeIndex + 1] || '', /\s*/);
    if (!inquiryDate) continue;
    inquiries.push({
      company,
      inquiryDate,
      type: /^hard$/i.test(lines[typeIndex]!) ? 'hard' : 'soft',
    });
    index = typeIndex + 1;
  }
  return inquiries;
}

function findEquifaxCreditorIndex(lines: string[], dateReportedIndex: number): number {
  for (let offset = dateReportedIndex - 1; offset >= Math.max(0, dateReportedIndex - 8); offset -= 1) {
    const line = lines[offset]!;
    if (!isEquifaxMetadataLine(line)) return offset;
  }
  return -1;
}

function equifaxLineValue(lines: string[], label: string): string | null {
  const pattern = new RegExp(`^\\|?\\s*${escapeRegExp(label)}\\s*:?\\s*(.*)$`, 'i');
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index]!);
    if (!match) continue;
    const inline = match[1]?.trim();
    if (inline) return inline;
    for (let offset = index + 1; offset < lines.length; offset += 1) {
      const value = lines[offset]?.trim();
      if (!value) continue;
      if (/^\|?\s*(Date Reported|Balance|Account Number|Owner|Credit Limit|High Credit|Loan\/Account Type|Status|Date Opened|Date of 1st Delinquency|Terms Frequency|Date of Last Activity|Date Major Delinquency|Months Reviewed|Scheduled Payment Amount|Actual Payment Amount|Past Due Amount|High Credit|Term Duration|Activity Designator|Narrative Code)/i.test(value)) {
        return null;
      }
      return value;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isEquifaxMetadataLine(value: string): boolean {
  return /^(?:PO Box|P\.?O\.? Box|\d{1,6}\s|Phone:|Prepared for:|Confirmation #|Date:|Page \d+|000000001-DISC|Narrative Code|Narrative Code Description|Credit Accounts|This includes|LE LI$)/i.test(value) ||
    /\|\s*\(\d{3}\)\s*\d{3}-\d{4}/.test(value) ||
    /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(value) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value);
}

function extractCreditTradelines(text: string): CreditTradeline[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const labeledCreditor = /^(?:account\s+name|creditor|furnisher|lender|company)\s*:?\s*(.+)$/i.exec(line);
    const nextMentionsAccount = /account\s*(?:number|#)\b/i.test(lines[index + 1] || '');
    if (!labeledCreditor && !nextMentionsAccount) continue;
    const first = labeledCreditor?.[1]?.trim() || line;
    if (!first || /^(account|creditor|furnisher|lender|company)$/i.test(first)) continue;
    const blockLines = [first];
    for (let offset = index + 1; offset < Math.min(lines.length, index + 18); offset += 1) {
      const candidate = lines[offset]!;
      if (offset > index + 2 && /^(?:account\s+name|creditor|furnisher|lender|company)\s*:?\s*\S+/i.test(candidate)) break;
      if (/^(?:inquir|personal information|public record|summary)\b/i.test(candidate)) break;
      blockLines.push(candidate);
    }
    const block = blockLines.join('\n');
    if (/(balance|credit\s+limit|account\s+number|status|past\s+due|date\s+opened)/i.test(block)) blocks.push(block);
  }

  const seen = new Set<string>();
  return blocks.flatMap((block) => {
    const account = creditTradelineFromBlock(block);
    if (!account) return [];
    const key = [account.creditor.toLowerCase(), account.accountMask || '', account.balanceMinor || '', account.creditLimitMinor || ''].join('|');
    if (seen.has(key)) return [];
    seen.add(key);
    return [account];
  });
}

function creditTradelineFromBlock(block: string): CreditTradeline | null {
  const first = block.split('\n')[0]?.replace(/^(?:account\s+name|creditor|furnisher|lender|company)\s*:?\s*/i, '').trim();
  if (!first || first.length < 2) return null;
  const status = field(block, ['status', 'account status', 'payment status']);
  const accountType = field(block, ['account type', 'type']);
  const balanceMinor = moneyField(block, ['balance', 'current balance']);
  const creditLimitMinor = moneyField(block, ['credit limit', 'limit']);
  const pastDueMinor = moneyField(block, ['past due', 'amount past due']);
  const closed = /closed|paid and closed|date closed/i.test(block);
  const negative = /collection|charge.?off|delinquent|late|repossession|foreclosure|derogatory/i.test(`${status || ''}\n${block}`) ||
    (pastDueMinor !== null && pastDueMinor > 0);
  const revolving = /credit card|revolving|charge account/i.test(`${accountType || ''}\n${block}`) || creditLimitMinor !== null;
  return {
    creditor: first,
    accountMask: accountMask(block),
    accountType,
    status,
    isOpen: !closed && !/closed/i.test(status || ''),
    isNegative: negative,
    isRevolving: revolving,
    dateOpened: findDate(block, /(date\s+opened|opened)\s*:?\s*/i),
    dateReported: findDate(block, /(date\s+reported|reported)\s*:?\s*/i),
    balanceMinor,
    creditLimitMinor,
    pastDueMinor,
  };
}

function extractCreditInquiries(text: string): CreditInquiry[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const out: CreditInquiry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const block = lines.slice(index, index + 6).join('\n');
    const labeledCompany = /^(?:inquiry|company|requested by)\s*:?\s*(.+)$/i.exec(line)?.[1]?.trim();
    const hasInquirySpecificFields = /(inquiry date|permissible purpose|requested by)\s*:?/i.test(block) ||
      /type\s*:?\s*(?:hard|soft)\s+inquiry/i.test(block);
    if (!labeledCompany && !hasInquirySpecificFields) continue;
    const company = (labeledCompany || line).replace(/^(?:inquiry|company|requested by)\s*:?\s*/i, '').trim();
    if (!company || isInquiryNoiseLine(company)) continue;
    out.push({
      company,
      inquiryDate: findDate(block, /(date|inquiry date)\s*:?\s*/i),
      type: /soft|promotional|account review|consumer|self/i.test(block) ? 'soft' : 'hard',
    });
  }
  return out.slice(0, 50);
}

function isInquiryNoiseLine(value: string): boolean {
  return /^(?:hard|soft)?\s*inquiries?$/i.test(value) ||
    /^(?:hard|soft)\s+inquiry$/i.test(value) ||
    /^(?:type|date|date\(s\)|inquiry date|permissible purpose|requested by)$/i.test(value) ||
    /^(?:this section shows|this inquiry|a request for your credit history|too many hard inquiries|hard inquiries that can|soft inquiries that do|these are inquiries|you've applied for credit|and any unfamiliar inquiries|you have a right to receive)/i.test(value) ||
    /\b(?:credit report|credit history|credit rating\/score|impact your credit score|identity theft|relating to a credit transaction)\b/i.test(value);
}

// Report date if parsed, else upload time; invalid/missing sorts oldest. Kept in
// sync with reportDateTime() in web/app.js so both rank reports identically.
function creditReportSortTime(report: CreditReportRecord): number {
  const time = new Date(report.reportDate || report.createdAt || '').getTime();
  return Number.isFinite(time) ? time : 0;
}

function sanitizeCreditReport(report: CreditReportRecord): CreditReportRecord {
  const raw = report.raw ?? {};
  const inquiries = asArray<CreditInquiry>(raw.inquiries)
    .filter((inquiry) => inquiry.company && !isInquiryNoiseLine(inquiry.company));
  return {
    ...report,
    inquiries: inquiries.filter((inquiry) => inquiry.type === 'hard').length,
    raw: {
      ...raw,
      inquiries,
      suggestions: suggestCreditDisputes(asArray<CreditTradeline>(raw.accounts), inquiries),
    },
  };
}

function suggestCreditDisputes(accounts: CreditTradeline[], inquiries: CreditInquiry[]): CreditDisputeSuggestion[] {
  const suggestions: CreditDisputeSuggestion[] = [];
  for (const account of accounts) {
    if (account.isNegative) {
      suggestions.push({
        severity: 'high',
        issue: 'Negative status or past-due balance',
        creditor: account.creditor,
        accountMask: account.accountMask,
        why: 'Negative, late, collection, charge-off, or past-due information should be reviewed against your records.',
        fcra: 'FCRA Section 611 - right to dispute inaccurate or incomplete information',
        reason: 'The reported negative status, late payment, collection, or past-due amount appears inaccurate or incomplete.',
      });
    }
    if (!account.isOpen && (account.balanceMinor ?? 0) > 0) {
      suggestions.push({
        severity: 'medium',
        issue: 'Closed account reports a balance',
        creditor: account.creditor,
        accountMask: account.accountMask,
        why: 'Closed tradelines with balances can be valid, but often deserve review if the account was paid or transferred.',
        fcra: 'FCRA Section 611 - right to dispute inaccurate or incomplete information',
        reason: 'The account is shown closed but still reports a balance that I believe is inaccurate or incomplete.',
      });
    }
  }
  for (const inquiry of inquiries.filter((item) => item.type === 'hard')) {
    suggestions.push({
      severity: 'low',
      issue: 'Hard inquiry to review',
      creditor: inquiry.company,
      accountMask: null,
      why: 'Hard inquiries should match applications you authorized.',
      fcra: 'FCRA Section 611 - right to dispute inaccurate information',
      reason: 'I do not recognize or did not authorize this hard inquiry.',
    });
  }
  return suggestions.slice(0, 20);
}

function summarizeCreditExtraction(extracted: CreditExtraction) {
  const utilization = creditUtilization(extracted.accounts);
  return {
    utilizationPercent: utilization.overallLimitMinor > 0 ? utilization.overallUtilizationPercent : null,
    totalBalanceMinor: utilization.overallBalanceMinor || null,
    totalLimitMinor: utilization.overallLimitMinor || null,
  };
}

function creditUtilization(accounts: CreditTradeline[]) {
  const cards = accounts
    .filter((account) => account.isOpen && account.isRevolving && (account.creditLimitMinor ?? 0) > 0)
    .map((account) => ({
      creditor: account.creditor,
      accountMask: account.accountMask,
      balanceMinor: Math.max(0, account.balanceMinor ?? 0),
      creditLimitMinor: account.creditLimitMinor ?? 0,
      utilizationPercent: Math.round((Math.max(0, account.balanceMinor ?? 0) / (account.creditLimitMinor ?? 1)) * 1000) / 10,
    }));
  const overallBalanceMinor = cards.reduce((sum, card) => sum + card.balanceMinor, 0);
  const overallLimitMinor = cards.reduce((sum, card) => sum + card.creditLimitMinor, 0);
  return {
    cards,
    overallBalanceMinor,
    overallLimitMinor,
    overallUtilizationPercent: overallLimitMinor > 0 ? Math.round((overallBalanceMinor / overallLimitMinor) * 1000) / 10 : null,
  };
}

function field(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const pattern = new RegExp(`${label.replace(/\s+/g, '\\s+')}\\s*:?\\s*([^\\n]+)`, 'i');
    const value = pattern.exec(text)?.[1]?.trim();
    if (value) return value.replace(/\s{2,}.*/, '').trim();
  }
  return null;
}

function lineValue(lines: string[], label: string): string | null {
  const index = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
  if (index < 0) return null;
  for (let offset = index + 1; offset < lines.length; offset += 1) {
    const value = lines[offset]?.trim();
    if (!value) continue;
    if (/^(Account Name|Account Number|Account Type|Responsibility|Interest Type|Date Opened|Status|Status Updated|Balance|Balance Updated|Recent Payment|Monthly Payment|Credit Limit|Highest Balance|Terms|On Record Until)$/i.test(value)) {
      return null;
    }
    return value;
  }
  return null;
}

function parseMoney(value: string | null): number | null {
  if (!value || value === '-') return null;
  const match = /\$?\s*([\d,]+(?:\.\d{1,2})?)/.exec(value);
  return match?.[1] ? toMinor(match[1].replace(/,/g, '')) : null;
}

function maskFromAccountNumber(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits ? `*${digits.slice(-4)}` : null;
}

function dedupeCreditAccounts(accounts: CreditTradeline[]): CreditTradeline[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    const key = [account.creditor.toLowerCase(), account.accountMask || '', account.dateOpened || '', account.creditLimitMinor ?? ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function moneyField(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const pattern = new RegExp(`${label.replace(/\s+/g, '\\s+')}\\s*:?\\s*\\$?([\\d,]+(?:\\.\\d{1,2})?)`, 'i');
    const value = pattern.exec(text)?.[1];
    if (value) return toMinor(value.replace(/,/g, ''));
  }
  return null;
}

function accountMask(text: string): string | null {
  const match = /(?:account\s*(?:number|#)|acct\s*#)\s*:?\s*([xX*\- ]*\d{4,})/i.exec(text);
  if (!match?.[1]) return null;
  const digits = match[1].replace(/\D/g, '');
  return digits.length ? `*${digits.slice(-4)}` : null;
}

function findDate(text: string, prefix: RegExp): string | null {
  const start = prefix.exec(text);
  const haystack = start ? text.slice(start.index, start.index + 80) : text;
  const match = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i.exec(haystack);
  return match ? normalizeDate(match[1]!) : null;
}

function normalizeDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeBureau(value: string): string | null {
  const lower = value.toLowerCase();
  if (lower.includes('equifax')) return 'equifax';
  if (lower.includes('experian')) return 'experian';
  if (lower.includes('transunion') || lower.includes('trans union')) return 'transunion';
  return null;
}

function bureauDisputeAddress(bureau: string): string {
  if (bureau === 'equifax') return 'P.O. Box 740256\nAtlanta, GA 30374-0256';
  if (bureau === 'experian') return 'P.O. Box 4500\nAllen, TX 75013';
  if (bureau === 'transunion') return 'P.O. Box 2000\nChester, PA 19016-2000';
  return '[Look up the current dispute mailing address]';
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}
