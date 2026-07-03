import { createHash } from 'node:crypto';
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
  FinanceRepository,
  ProviderBalanceInput,
  ProviderBrokerageTransactionInput,
  ProviderHoldingInput,
  ProviderTransactionInput,
  StatementParser,
  SummaryQuery,
  TransactionQuery,
} from './ports.js';
import {
  assertIsoDate,
  assertMinorAmount,
  normalizeCurrency,
  requireText,
} from '../domain/invariants.js';
import type { Account, AccountBalance, AlertRuleRecord, BrokerageTransaction, CreditReportRecord, ImportRecord, Transaction, TransactionInput } from '../domain/models.js';
import { generateChatReply, LLM_PROVIDERS, resolveLlmConfig } from '../infrastructure/llm-gateway.js';
import { TelegramGateway, sendTelegramMessage } from '../infrastructure/telegram-gateway.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatContextAttachment {
  id: string;
  type: 'chart' | 'table';
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

export interface InsightSignal {
  id: string;
  kind: string;
  scope: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  value: string;
  source: 'rule';
  ruleId?: string | null;
  accountId?: string;
  createdAt: string;
}

interface ProviderSyncResult {
  accounts: number;
  transactions: number;
  balances: number;
  holdings: number;
  modified: number;
  removed: number;
  skipped: number;
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
}

export class FinanceService {
  private readonly telegramGateway: TelegramGateway;
  private readonly telegramHistory = new Map<string, ChatMessage[]>();
  private backgroundServicesStarted = false;
  private alertKick: ReturnType<typeof setTimeout> | undefined;
  private alertTimer: ReturnType<typeof setInterval> | undefined;
  private providerSyncKick: ReturnType<typeof setTimeout> | undefined;
  private providerSyncTimer: ReturnType<typeof setInterval> | undefined;
  private providerSyncInFlight: Promise<unknown> | null = null;

  constructor(
    private readonly repository: FinanceRepository,
    private readonly parsers: readonly StatementParser[],
  ) {
    this.telegramGateway = new TelegramGateway({
      getToken: () => this.telegramToken(),
      getChatId: () => this.repository.getAppSetting('TELEGRAM_CHAT_ID'),
      getLastUpdateId: () => Number(this.repository.getAppSetting('TELEGRAM_LAST_UPDATE_ID') || -1),
      saveLastUpdateId: (updateId) => {
        this.repository.saveAppSettings({ TELEGRAM_LAST_UPDATE_ID: String(updateId) });
      },
      onMessage: (text) => this.replyToTelegram(text),
    });
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
    const latest = reports[0] ?? null;
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
    const currentProviderId = (this.repository.getAppSetting('LLM_PROVIDER') || 'ollama').toLowerCase();
    if (nextProviderId && nextProviderId !== currentProviderId) {
      const provider = LLM_PROVIDERS.find((candidate) => candidate.id === nextProviderId);
      if (provider) {
        if (!('LLM_BASE_URL' in clean)) clean.LLM_BASE_URL = provider.baseUrl || '';
        if (!('LLM_MODEL' in clean)) clean.LLM_MODEL = provider.defaultModel;
        if (!('LLM_CHAT_MODEL' in clean)) clean.LLM_CHAT_MODEL = provider.defaultChatModel;
        if (!('LLM_API_KEY' in clean)) clean.LLM_API_KEY = '';
      }
    }
    this.repository.saveAppSettings(clean);
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
        TELEGRAM_CHAT_TYPE: chat.type || 'chat',
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
        },
      });
      this.repository.saveAppSettings({ active_bank_source: 'plaid' });
      return { ok: true, itemId, institution: institutionName, accounts: accountIds.length, connection };
    } catch (error) {
      throw connectorError('Plaid token exchange failed', error);
    }
  }

  async removePlaidConnection(itemId: string) {
    const id = requireText(itemId, 'item_id');
    throw new AppError('invalid_input', 'Plaid Item removal is disabled. Use Plaid account selection/update flow for account-level changes.', { itemId: id });
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
      const accountMap = await this.refreshPlaidAccounts(this.plaidClient(), id, secret.accessToken, connection);
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
      this.repository.saveAppSettings({ active_brokerage_source: 'snaptrade' });
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
    if (this.plaidConnectionsReady()) {
      result.plaid = await this.syncPlaid();
    }
    if (this.snapTradeReady()) {
      result.snaptrade = await this.syncSnapTrade();
      this.repository.saveAppSettings({ SNAPTRADE_LAST_AUTO_SYNC_AT: new Date().toISOString() });
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
      const accountMap = await this.refreshPlaidAccounts(client, connection.externalId, secret.accessToken, connection);
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
          });
        }
        const saved = this.repository.saveProviderTransactions(transactions);
        out.transactions += saved.inserted;
        out.skipped += saved.skipped;
        out.modified += data.modified.length;
        out.removed += data.removed.length;
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
        metadata: { ...secret.metadata, cursor: nextCursor, lastSyncAt: new Date().toISOString() },
      });
    }
    return out;
  }

  private async refreshPlaidAccounts(
    client: PlaidApi,
    itemId: string,
    accessToken: string,
    connection: { institution: string | null; environment: string | null },
  ): Promise<Map<string, { id: string; currency: string; domain: string }>> {
    const response = await client.accountsGet({ access_token: accessToken });
    const map = new Map<string, { id: string; currency: string; domain: string }>();
    const asOfDate = new Date().toISOString().slice(0, 10);
    const institution = connection.institution || normalizeProviderInstitution('Plaid');
    const balances: ProviderBalanceInput[] = [];
    for (const plaidAccount of response.data.accounts) {
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
      map.set(plaidAccount.account_id, { id: account.id, currency: account.currency, domain });
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
    return map;
  }

  private async syncPlaidInvestments(
    client: PlaidApi,
    accessToken: string,
    accountMap: Map<string, { id: string; currency: string; domain: string }>,
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
      const holdings: ProviderHoldingInput[] = (response.data.holdings || []).flatMap((holding: any) => {
        const account = accountMap.get(String(holding.account_id));
        if (!account) return [];
        const security = securities.get(String(holding.security_id)) || {};
        const quantity = numberOrNull(holding.quantity);
        const price = numberOrNull(holding.institution_price ?? security.close_price);
        const value = numberOrNull(holding.institution_value);
        if (value === null) return [];
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
    for (const snapAccount of (response.data || []) as Array<Record<string, any>>) {
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

    const insights = this.activeInsights();
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

  listInsights() {
    return this.activeInsights();
  }

  listAlertRules() {
    return this.repository.listAlertRules();
  }

  listRules() {
    return this.listAlertRules();
  }

  async previewAlertRule(input: { text: string; scope?: string | undefined; cadence?: string | undefined; channel?: string | undefined; scheduledHour?: number | null | undefined }) {
    const text = requireText(input.text, 'text');
    const heuristic = inferRule(text, input.scope, input.cadence);
    const modelInferred = await this.inferRuleWithModel(text, heuristic);
    const inferred = {
      ...modelInferred,
      scope: normalizeChoice(input.scope || modelInferred.scope, ['banking', 'brokerage', 'credit', 'all'], modelInferred.scope),
      cadence: normalizeChoice(input.cadence || modelInferred.cadence, ['event', 'hourly', 'daily', 'weekly', 'monthly'], modelInferred.cadence),
      channel: 'auto',
    };
    const scheduledHour = input.scheduledHour ?? suggestedRuleHour(inferred.cadence);
    return {
      text,
      ...inferred,
      scheduledHour,
      mode: ruleExecutionMode(inferred.kind),
      strategy: ruleExecutionStrategy(inferred.kind),
      inference: inferred.inference,
    };
  }

  async previewRule(input: { text: string; scope?: string | undefined; cadence?: string | undefined; channel?: string | undefined; scheduledHour?: number | null | undefined }) {
    return this.previewAlertRule(input);
  }

  createAlertRule(input: { text: string; scope?: string | undefined; cadence?: string | undefined; channel?: string | undefined; scheduledHour?: number | null | undefined }) {
    const text = requireText(input.text, 'text');
    const inferred = inferRule(text, input.scope, input.cadence);
    return this.repository.saveAlertRule({
      kind: inferred.kind,
      sourceText: text,
      scope: inferred.scope,
      cadence: inferred.cadence,
      channel: inferred.channel,
      scheduledHour: input.scheduledHour ?? null,
      enabled: true,
    });
  }

  createRule(input: { text: string; scope?: string | undefined; cadence?: string | undefined; channel?: string | undefined; scheduledHour?: number | null | undefined }) {
    return this.createAlertRule(input);
  }

  toggleAlertRule(id: string, enabled: boolean) {
    const rule = this.repository.toggleAlertRule(id, enabled);
    if (!rule) throw new AppError('not_found', 'Rule not found', { id });
    return rule;
  }

  toggleRule(id: string, enabled: boolean) {
    return this.toggleAlertRule(id, enabled);
  }

  removeAlertRule(id: string) {
    return { removed: this.repository.removeAlertRule(id) };
  }

  removeRule(id: string) {
    return this.removeAlertRule(id);
  }

  listAlertMutes() {
    return this.repository.listAlertMutes();
  }

  listInsightMutes() {
    return this.listAlertMutes();
  }

  createAlertMute(input: { kind?: string | null | undefined; accountId?: string | null | undefined; label?: string | null | undefined; days?: number | null | undefined }) {
    const days = Number(input.days || 0);
    const expiresAt = Number.isFinite(days) && days > 0
      ? new Date(Date.now() + Math.round(days) * 86_400_000).toISOString()
      : null;
    return this.repository.saveAlertMute({
      kind: input.kind || null,
      accountId: input.accountId || null,
      label: input.label || null,
      expiresAt,
    });
  }

  createInsightMute(input: { kind?: string | null | undefined; accountId?: string | null | undefined; label?: string | null | undefined; days?: number | null | undefined }) {
    return this.createAlertMute(input);
  }

  removeAlertMute(id: string) {
    return { removed: this.repository.removeAlertMute(id) };
  }

  removeInsightMute(id: string) {
    return this.removeAlertMute(id);
  }

  async chat(messages: ChatMessage[], section?: string, contextAttachments: ChatContextAttachment[] = []) {
    const prompt = messages.at(-1)?.content?.trim();
    if (!prompt) throw new AppError('invalid_input', 'A chat message is required');
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
    const system = [
      'You are Finora, a local-first personal finance assistant.',
      'Use only the local context provided below. Do not claim to have synced live accounts.',
      'Do not provide financial, tax, or legal advice. Give factual summaries, point out risks, and suggest review steps.',
      'All fields ending in Minor are minor currency units. Divide them by 100 before presenting dollars.',
      'Keep replies concise and use the user language when obvious.',
      'If a requested action is not available, say what local screen or setting to use.',
      '',
      'Local context:',
      JSON.stringify(context, null, 2),
    ].join('\n');
    try {
      const reply = await generateChatReply({
        config: llm,
        system,
        messages: messages.slice(-8),
        timeoutMs: 120_000,
        maxTokens: 768,
      });
      return { provider: llm.provider, model: llm.chatModel, local: llm.local, reply };
    } catch (error) {
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
      const reply = await generateChatReply({
        config: llm,
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
      const message = error instanceof Error ? error.message : 'The configured model request failed';
      throw new AppError('external_service', `LLM connection failed: ${message}`, {
        provider: llm.provider,
        model: llm.chatModel,
      });
    }
  }

  getLlmStatus() {
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
      })),
    };
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

    const extracted = await extractCreditReport(input.content, filename);
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

    return this.repository.saveImport({
      account,
      filename,
      format: parser.format,
      contentHash,
      transactions,
    });
  }

  close(): void {
    this.telegramGateway.stop();
    if (this.alertKick) clearTimeout(this.alertKick);
    if (this.alertTimer) clearInterval(this.alertTimer);
    if (this.providerSyncKick) clearTimeout(this.providerSyncKick);
    if (this.providerSyncTimer) clearInterval(this.providerSyncTimer);
    this.repository.close();
  }

  private telegramToken(): string | null {
    return this.repository.getAppSetting('TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN || null;
  }

  private async replyToTelegram(text: string): Promise<string> {
    const chatId = this.repository.getAppSetting('TELEGRAM_CHAT_ID') || 'owner';
    if (/^\/help(?:@\w+)?$/i.test(text) || /^\/start(?:@\w+)?$/i.test(text)) {
      return 'Ask a question about the accounts, transactions, holdings, balances, rules, or insights stored in Finora.';
    }

    const history = this.telegramHistory.get(chatId) || [];
    history.push({ role: 'user', content: text });
    const result = await this.chat(history.slice(-8), 'telegram');
    history.push({ role: 'assistant', content: result.reply });
    this.telegramHistory.set(chatId, history.slice(-16));
    return result.reply;
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

  private async inferRuleWithModel(text: string, fallback: ReturnType<typeof inferRule>) {
    const llm = this.llmConfig();
    try {
      const reply = await generateChatReply({
        config: llm,
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
      const metadataItemId = String(account.metadata?.plaidItemId || account.metadata?.itemId || account.metadata?.item_id || '');
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
    const insights = this.localInsights();
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

  private localInsights(): InsightSignal[] {
    const insights: InsightSignal[] = [];
    const accounts = this.repository.listAccounts();
    const connections = this.repository.listProviderConnections();
    for (const connection of connections) {
      if (connection.status !== 'active' || !connection.hasAccessToken) {
        insights.push({
          id: `connection:${connection.provider}:${connection.externalId}`,
          kind: 'connection_health',
          scope: connection.provider,
          severity: 'high',
          title: `${connection.institution || connection.provider} connection needs review`,
          detail: `Status ${connection.status}; token saved: ${connection.hasAccessToken ? 'yes' : 'no'}.`,
          value: 'Review',
          source: 'rule',
          ruleId: null,
          createdAt: connection.updatedAt,
        });
      }
    }
    const balances = latestByAccount(this.repository.listAccountBalances());
    for (const balance of balances) {
      if (balance.currentMinor > 0 && balance.cashMinor !== null && balance.cashMinor / balance.currentMinor >= 0.3) {
        const accountName = accounts.find((account) => account.id === balance.accountId)?.name || 'Brokerage';
        insights.push({
          id: `brokerage_cash_drag:${balance.accountId}:${balance.asOfDate}`,
          kind: 'brokerage_cash_drag',
          scope: 'brokerage',
          severity: 'low',
          title: `${accountName} cash drag`,
          detail: `${formatMinorAmount(balance.cashMinor, balance.currency)} cash on ${formatMinorAmount(balance.currentMinor, balance.currency)} current value.`,
          value: `${Math.round((balance.cashMinor / balance.currentMinor) * 100)}%`,
          source: 'rule',
          ruleId: null,
          accountId: balance.accountId,
          createdAt: balance.createdAt,
        });
      }
    }
    const holdings = this.repository.listBrokerageHoldings();
    const total = holdings.reduce((sum, holding) => sum + holding.valueMinor, 0);
    const largest = holdings.slice().sort((a, b) => b.valueMinor - a.valueMinor)[0];
    if (largest && total > 0 && largest.valueMinor / total >= 0.2) {
      insights.push({
        id: `portfolio_concentration:${largest.id}`,
        kind: 'portfolio_concentration',
        scope: 'brokerage',
        severity: 'medium',
        title: `${largest.symbol || largest.name || 'Top holding'} concentration`,
        detail: `${formatMinorAmount(largest.valueMinor, largest.currency)} of ${formatMinorAmount(total, largest.currency)} tracked holdings.`,
        value: `${Math.round((largest.valueMinor / total) * 100)}%`,
        source: 'rule',
        ruleId: null,
        accountId: largest.accountId,
        createdAt: largest.createdAt,
      });
    }
    insights.push(...this.ruleDrivenInsights(accounts, balances));
    return insights;
  }

  private ruleDrivenInsights(accounts: Account[], balances: AccountBalance[]): InsightSignal[] {
    const insights: InsightSignal[] = [];
    const rules = this.repository.listAlertRules().filter((rule) => rule.enabled);
    for (const rule of rules) {
      if (rule.kind === 'rule_spending_watch') {
        if (ruleWatchesCreditCardTransactions(rule)) {
          insights.push(...this.creditCardTransactionInsights(rule, accounts));
        }
        if (ruleWatchesBrokerageTransactions(rule)) {
          insights.push(...this.brokerageTransactionInsights(rule, accounts));
        }
        insights.push(...this.largeTransactionInsights(rule, accounts));
        continue;
      }
      if (rule.kind === 'rule_idle_brokerage_cash' || rule.kind === 'rule_idle_cash') {
        insights.push(...this.idleCashInsights(rule, accounts, balances));
        continue;
      }
      if (rule.kind === 'rule_portfolio_watch') {
        insights.push(...this.portfolioInsights(rule, accounts));
        continue;
      }
      if (rule.kind === 'rule_credit_utilization') {
        insights.push(...this.creditUtilizationInsights(rule, accounts, balances));
        continue;
      }
      if (rule.kind === 'rule_connection_health') {
        insights.push(...this.connectionInsights(rule));
        continue;
      }
      if (rule.kind === 'rule_local_watch') {
        insights.push(...this.localWatchInsights(rule, accounts, balances));
      }
    }
    return insights;
  }

  private creditCardTransactionInsights(rule: AlertRuleRecord, accounts: Account[]): InsightSignal[] {
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    return this.repository.listTransactions({ limit: 100 }).items
      .filter((transaction) => transaction.createdAt >= rule.createdAt)
      .filter((transaction) => isCreditAccount(accountById.get(transaction.accountId)))
      .slice(0, 20)
      .map((transaction) => transactionInsight(rule, transaction, accountById.get(transaction.accountId), 'credit card'));
  }

  private brokerageTransactionInsights(rule: AlertRuleRecord, accounts: Account[]): InsightSignal[] {
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    return this.repository.listBrokerageTransactions({ limit: 100 }).items
      .filter((transaction) => transaction.createdAt >= rule.createdAt)
      .slice(0, 20)
      .map((transaction) => transactionInsight(rule, transaction, accountById.get(transaction.accountId), 'brokerage'));
  }

  private largeTransactionInsights(rule: AlertRuleRecord, accounts: Account[]): InsightSignal[] {
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    return this.repository.listTransactions({ limit: 100 }).items
      .filter((transaction) => transaction.createdAt >= rule.createdAt)
      .filter((transaction) => transaction.amountMinor < 0 && Math.abs(transaction.amountMinor) >= 50000)
      .slice(0, 20)
      .map((transaction) => transactionInsight(rule, transaction, accountById.get(transaction.accountId), 'large'));
  }

  private idleCashInsights(rule: AlertRuleRecord, accounts: Account[], balances: AccountBalance[]): InsightSignal[] {
    const latest = latestByAccount(balances);
    const threshold = rule.kind === 'rule_idle_brokerage_cash' ? 0.25 : 0.3;
    return latest
      .filter((balance) => {
        const acct = accounts.find((account) => account.id === balance.accountId);
        const isBrokerage = acct?.domain === 'brokerage';
        const cashMinor = isBrokerage ? balance.cashMinor : balance.availableMinor ?? balance.currentMinor;
        if (cashMinor === null || cashMinor === undefined || balance.currentMinor <= 0) return false;
        if (rule.kind === 'rule_idle_brokerage_cash' && !isBrokerage) return false;
        if (rule.kind === 'rule_idle_cash' && isBrokerage) return false;
        return cashMinor / balance.currentMinor >= threshold;
      })
      .map((balance) => {
        const acct = accounts.find((account) => account.id === balance.accountId);
        const cashMinor = acct?.domain === 'brokerage' ? balance.cashMinor ?? 0 : balance.availableMinor ?? balance.currentMinor;
        return {
          id: `${rule.kind}:${rule.id}:${balance.accountId}:${balance.asOfDate}`,
          kind: `${rule.kind}:${rule.id}:${balance.accountId}`,
          scope: rule.scope,
          severity: 'low' as const,
          title: `${acct?.name || 'Account'} has idle cash`,
          detail: `${formatMinorAmount(cashMinor, balance.currency)} available against ${formatMinorAmount(balance.currentMinor, balance.currency)} current balance.`,
          value: `${Math.round((cashMinor / balance.currentMinor) * 100)}%`,
          source: 'rule' as const,
          ruleId: rule.id,
          accountId: balance.accountId,
          createdAt: balance.createdAt,
        };
      });
  }

  private portfolioInsights(rule: AlertRuleRecord, accounts: Account[]): InsightSignal[] {
    const holdings = this.repository.listBrokerageHoldings();
    const total = holdings.reduce((sum, holding) => sum + holding.valueMinor, 0);
    const largest = holdings.slice().sort((a, b) => b.valueMinor - a.valueMinor)[0];
    if (!largest || total <= 0 || largest.valueMinor / total < 0.2) return [];
    const accountName = accounts.find((account) => account.id === largest.accountId)?.name || 'Brokerage';
    return [{
      id: `${rule.kind}:${rule.id}:${largest.id}`,
      kind: `${rule.kind}:${rule.id}:${largest.id}`,
      scope: rule.scope,
      severity: 'medium',
      title: `${largest.symbol || largest.name || 'Top holding'} concentration`,
      detail: `${accountName} holds ${formatMinorAmount(largest.valueMinor, largest.currency)} of ${formatMinorAmount(total, largest.currency)} tracked holdings.`,
      value: `${Math.round((largest.valueMinor / total) * 100)}%`,
      source: 'rule',
      ruleId: rule.id,
      accountId: largest.accountId,
      createdAt: largest.createdAt,
    }];
  }

  private creditUtilizationInsights(rule: AlertRuleRecord, accounts: Account[], balances: AccountBalance[]): InsightSignal[] {
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    return latestByAccount(balances)
      .filter((balance) => isCreditAccount(accountById.get(balance.accountId)) && Boolean(balance.limitMinor) && balance.currentMinor > 0)
      .filter((balance) => balance.limitMinor !== null && balance.currentMinor / balance.limitMinor >= 0.3)
      .map((balance) => {
        const acct = accountById.get(balance.accountId);
        const ratio = balance.limitMinor ? balance.currentMinor / balance.limitMinor : 0;
        return {
          id: `${rule.kind}:${rule.id}:${balance.accountId}:${balance.asOfDate}`,
          kind: `${rule.kind}:${rule.id}:${balance.accountId}`,
          scope: rule.scope,
          severity: ratio >= 0.7 ? 'high' as const : 'medium' as const,
          title: `${acct?.name || 'Credit account'} utilization is elevated`,
          detail: `${formatMinorAmount(balance.currentMinor, balance.currency)} balance on ${formatMinorAmount(balance.limitMinor || 0, balance.currency)} limit.`,
          value: `${Math.round(ratio * 100)}%`,
          source: 'rule' as const,
          ruleId: rule.id,
          accountId: balance.accountId,
          createdAt: balance.createdAt,
        };
      });
  }

  private connectionInsights(rule: AlertRuleRecord): InsightSignal[] {
    return this.repository.listProviderConnections()
      .filter((connection) => connection.status !== 'active' || !connection.hasAccessToken || (connection.provider === 'plaid' && !connection.hasCursor))
      .map((connection) => ({
        id: `${rule.kind}:${rule.id}:${connection.provider}:${connection.externalId}`,
        kind: `${rule.kind}:${rule.id}:${connection.provider}:${connection.externalId}`,
        scope: rule.scope,
        severity: 'high' as const,
        title: `${connection.institution || connection.provider} connection needs review`,
        detail: `Status ${connection.status}; token saved: ${connection.hasAccessToken ? 'yes' : 'no'}; cursor saved: ${connection.hasCursor ? 'yes' : 'no'}.`,
        value: 'Review',
        source: 'rule' as const,
        ruleId: rule.id,
        createdAt: connection.updatedAt,
      }));
  }

  private localWatchInsights(rule: AlertRuleRecord, accounts: Account[], balances: AccountBalance[]): InsightSignal[] {
    return [
      ...this.idleCashInsights(rule, accounts, balances),
      ...this.connectionInsights(rule),
      ...this.portfolioInsights(rule, accounts),
    ].slice(0, 20);
  }

  private activeInsights(): InsightSignal[] {
    const now = Date.now();
    const mutes = this.repository.listAlertMutes().filter((mute) => {
      if (!mute.expiresAt) return true;
      const expires = new Date(mute.expiresAt).getTime();
      return Number.isFinite(expires) && expires > now;
    });
    return this.localInsights().filter((insight) => !mutes.some((mute) =>
      (!mute.kind || mute.kind === insight.kind) &&
      (!mute.accountId || mute.accountId === insight.accountId)
    ));
  }

}

function inferRule(text: string, scope?: string, cadence?: string) {
  const lower = text.toLowerCase();
  const inferredScope = scope || (
    /brokerage|portfolio|holding|stock|etf|dividend|cash drag|order|trade|allocation|投资|持仓/.test(lower) ? 'brokerage'
      : /credit|card|utilization|score|信用|卡/.test(lower) ? 'credit'
        : /net[ -]?worth|balance sheet|asset|liability/.test(lower) ? 'all'
          : 'banking'
  );
  const inferredCadence = cadence || (
    /monthly|month|每月/.test(lower) ? 'monthly'
      : /weekly|week|每周/.test(lower) ? 'weekly'
        : /daily|day|每天|每日/.test(lower) ? 'daily'
          : /hourly|hour|每小时/.test(lower) ? 'hourly'
          : 'event'
  );
  let kind = 'rule_local_watch';
  if (/cash|现金|idle/.test(lower)) kind = inferredScope === 'brokerage' ? 'rule_idle_brokerage_cash' : 'rule_idle_cash';
  else if (/duplicate|unusual|merchant|spend|charge|transaction|消费|支出/.test(lower)) kind = 'rule_spending_watch';
  else if (/portfolio|concentration|holding|持仓|集中/.test(lower)) kind = 'rule_portfolio_watch';
  else if (/credit|card|utilization|score|信用|卡/.test(lower)) kind = 'rule_credit_utilization';
  else if (/connection|sync|token|cursor|plaid|snaptrade/.test(lower)) kind = 'rule_connection_health';
  return {
    kind,
    scope: normalizeChoice(inferredScope, ['banking', 'brokerage', 'credit', 'all'], 'banking'),
    cadence: normalizeChoice(inferredCadence, ['event', 'hourly', 'daily', 'weekly', 'monthly'], 'event'),
    channel: 'auto',
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

function ruleWatchesCreditCardTransactions(rule: AlertRuleRecord): boolean {
  const text = `${rule.scope} ${rule.sourceText}`.toLowerCase();
  return rule.scope === 'credit' || (/transaction|charge|spend|消费|支出/.test(text) && /credit|card|信用卡/.test(text));
}

function ruleWatchesBrokerageTransactions(rule: AlertRuleRecord): boolean {
  const text = `${rule.scope} ${rule.sourceText}`.toLowerCase();
  return rule.scope === 'brokerage' || (/transaction|activity|trade|order/.test(text) && /brokerage|portfolio|stock|etf|trade|order/.test(text));
}

function isCreditAccount(account: Account | undefined): boolean {
  if (!account) return false;
  return /credit|card/i.test(`${account.type || ''} ${account.name || ''}`);
}

function transactionInsight(
  rule: AlertRuleRecord,
  transaction: Transaction | BrokerageTransaction,
  account: Account | undefined,
  label: 'credit card' | 'brokerage' | 'large',
): InsightSignal {
  const accountName = account?.name || 'Unknown account';
  const amount = formatMinorAmount(transaction.amountMinor, transaction.currency);
  const titleLabel = label === 'large' ? 'large transaction' : `${label} transaction`;
  return {
    id: `${rule.kind}:${rule.id}:${transaction.id}`,
    kind: `${rule.kind}:${rule.id}:${transaction.id}`,
    scope: rule.scope,
    severity: 'medium',
    title: `New ${titleLabel}: ${transaction.description}`,
    detail: `${accountName} · ${transaction.date} · ${amount}`,
    value: amount,
    source: 'rule',
    ruleId: rule.id,
    accountId: transaction.accountId,
    createdAt: transaction.createdAt,
  };
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

function ruleExecutionMode(kind: string) {
  if (/credit_utilization|connection_health/.test(kind)) return 'D';
  if (/spending_watch|local_watch/.test(kind)) return 'L+';
  return 'L';
}

function ruleExecutionStrategy(kind: string) {
  const mode = ruleExecutionMode(kind);
  if (mode === 'D') return 'Deterministic query and local copy; no model is needed at run time.';
  if (mode === 'L') return 'Deterministic trigger with model-generated explanation from local facts.';
  return 'Deterministic prefilter, then model accept/reject with deterministic fallback.';
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
  };
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

function insightIdentity(insight: InsightSignal): string {
  return createHash('sha256')
    .update([insight.kind, insight.scope, insight.accountId || '', insight.title].join('|'))
    .digest('hex');
}

function formatImInsights(insights: InsightSignal[]): string {
  const icon = { high: '🔴', medium: '🟠', low: '🟡' } as const;
  const lines = insights.map((insight) => `${icon[insight.severity]} ${insight.title}\n${insight.detail}`);
  return `Finora — ${insights.length} new insight${insights.length === 1 ? '' : 's'}\n\n${lines.join('\n\n')}`;
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

function extractExperianInquiries(text: string): CreditInquiry[] {
  const start = text.indexOf('Hard Inquiries');
  if (start < 0) return [];
  const end = text.indexOf('Soft Inquiries', start);
  const section = text.slice(start, end > start ? end : start + 8000);
  const lines = section.split('\n').map((line) => line.trim()).filter(Boolean);
  const inquiries: CreditInquiry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^Inquired on$/i.test(lines[index]!)) continue;
    const date = normalizeDate(lines[index + 1] || '');
    const companyParts: string[] = [];
    for (let offset = index - 1; offset >= 0 && companyParts.length < 4; offset -= 1) {
      const value = lines[offset]!;
      if (/^(Hard Inquiries|No public records reported\.|This inquiry|on behalf of|Credit Granting\.|Auto loan\.|Unspeciced\.|Real Estate)$/i.test(value)) break;
      if (/^(PO BOX|\d|\(?\d{3}\)|[A-Z]{2},?\s*\d{5})/.test(value)) break;
      companyParts.unshift(value);
    }
    const company = companyParts.join(' ').trim();
    if (company && date) inquiries.push({ company, inquiryDate: date, type: 'hard' });
  }
  return inquiries;
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
