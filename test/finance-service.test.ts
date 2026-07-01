import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceService } from '../src/application/finance-service.js';
import { CsvStatementParser } from '../src/infrastructure/parsers/csv-parser.js';
import { OfxStatementParser } from '../src/infrastructure/parsers/ofx-parser.js';
import { SqliteFinanceRepository } from '../src/infrastructure/sqlite-repository.js';

afterEach(() => vi.unstubAllGlobals());

function application() {
  return new FinanceService(
    new SqliteFinanceRepository(':memory:'),
    [new OfxStatementParser(), new CsvStatementParser()],
  );
}

describe('FinanceService', () => {
  it('pushes each active local alert to Telegram once until it resolves', async () => {
    const repository = new SqliteFinanceRepository(':memory:');
    repository.saveAppSettings({
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHAT_ID: '123',
      NOTIFICATION_CHANNEL: 'telegram',
    });
    repository.saveProviderConnection({
      provider: 'plaid',
      externalId: 'item-needs-review',
      institution: 'Example Bank',
      status: 'error',
    });
    const service = new FinanceService(repository, [new OfxStatementParser(), new CsvStatementParser()]);
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: {} });
    }));

    await expect(service.notifyTelegramAlerts()).resolves.toMatchObject({ count: 1, sent: true });
    await expect(service.notifyTelegramAlerts()).resolves.toMatchObject({ count: 0, sent: false, reason: 'no-new-alerts' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Example Bank connection needs review');
    service.close();
  });

  it('imports, deduplicates, lists, paginates, and summarizes transactions', async () => {
    const service = application();
    const account = service.createAccount({
      institution: 'Example Bank',
      name: 'Daily Checking',
      type: 'checking',
      currency: 'usd',
    });
    const content = await readFile(new URL('./fixtures/checking.csv', import.meta.url));

    const imported = service.importStatement({ accountId: account.id, filename: 'checking.csv', content });
    expect(imported).toMatchObject({ insertedCount: 3, skippedCount: 0, format: 'csv' });

    const repeated = service.importStatement({ accountId: account.id, filename: 'renamed.csv', content });
    expect(repeated.id).toBe(imported.id);
    expect(service.listTransactions({ limit: 2 }).items).toHaveLength(2);

    const firstPage = service.listTransactions({ limit: 2 });
    expect(firstPage.nextCursor).toBeTypeOf('string');
    const secondPage = service.listTransactions({ limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(3);

    expect(service.summarize()).toEqual([{
      currency: 'USD', incomeMinor: 250000, expenseMinor: 12647, netMinor: 237353,
    }]);
    service.close();
  });

  it('deduplicates transactions across different files', () => {
    const service = application();
    const account = service.createAccount({
      institution: 'Example Bank', name: 'Savings', type: 'savings', currency: 'USD',
    });
    const first = Buffer.from('Date,Description,Amount,Transaction ID\n2026-01-01,Interest,1.00,same\n');
    const second = Buffer.from('Date,Description,Amount,Transaction ID\n2026-01-01,Interest,1.00,same\n2026-02-01,Interest,2.00,new\n');
    service.importStatement({ accountId: account.id, filename: 'one.csv', content: first });
    const result = service.importStatement({ accountId: account.id, filename: 'two.csv', content: second });
    expect(result).toMatchObject({ insertedCount: 1, skippedCount: 1 });
    expect(service.listTransactions().items).toHaveLength(2);
    service.close();
  });

  it('scopes file idempotency to an account', () => {
    const service = application();
    const first = service.createAccount({
      institution: 'Example Bank', name: 'Checking', type: 'checking', currency: 'USD',
    });
    const second = service.createAccount({
      institution: 'Example Bank', name: 'Savings', type: 'savings', currency: 'USD',
    });
    const content = Buffer.from('Date,Description,Amount\n2026-01-01,Opening balance,10.00\n');
    const firstImport = service.importStatement({ accountId: first.id, filename: 'one.csv', content });
    const secondImport = service.importStatement({ accountId: second.id, filename: 'two.csv', content });
    expect(secondImport.id).not.toBe(firstImport.id);
    expect(service.listTransactions().items).toHaveLength(2);
    service.close();
  });

  it('refuses hard deletion of provider-managed accounts', () => {
    const service = application();
    const first = service.createAccount({
      institution: 'Example Bank',
      name: 'Checking',
      type: 'checking',
      currency: 'USD',
      source: 'plaid',
      providerAccountId: 'plaid-account-checking',
    });

    expect(() => service.removeAccount(first.id)).toThrow('managed by Plaid');
    expect(service.getAccount(first.id)).toMatchObject({ name: 'Checking' });
    expect(service.listProviderConnections()).toHaveLength(0);
    service.close();
  });

  it('stores provider connections only through the provider connection port', () => {
    const repository = new SqliteFinanceRepository(':memory:');
    const saved = repository.saveProviderConnection({
      provider: 'plaid',
      externalId: 'item-existing-bank',
      institution: 'Example Bank',
      environment: 'sandbox',
      accessToken: 'access-sandbox',
      cursor: 'cursor-1',
      metadata: { accountIds: ['plaid-account-checking'] },
    });
    expect(saved).toMatchObject({
      provider: 'plaid',
      externalId: 'item-existing-bank',
      status: 'active',
      hasAccessToken: true,
      hasCursor: true,
    });
    expect(repository.listProviderConnections()).toHaveLength(1);
    repository.close();
  });

  it('removes local file accounts and their imported rows', async () => {
    const service = application();
    const account = service.createAccount({
      institution: 'Example Bank',
      name: 'Temporary Checking',
      type: 'checking',
      currency: 'USD',
    });
    const content = await readFile(new URL('./fixtures/checking.csv', import.meta.url));
    service.importStatement({ accountId: account.id, filename: 'checking.csv', content });
    expect(service.listTransactions({ accountId: account.id, limit: 10 }).items).toHaveLength(3);

    expect(service.removeAccount(account.id)).toEqual({ ok: true });
    expect(() => service.getAccount(account.id)).toThrow('Account not found');
    expect(service.listTransactions({ accountId: account.id, limit: 10 }).items).toHaveLength(0);
    service.close();
  });

  it('parses text-searchable credit reports into tradelines and dispute templates', async () => {
    const service = application();
    const pdf = Buffer.from(`%PDF-1.7
Equifax Credit Report
Report Date: 06/15/2026
FICO Score: 712
Creditor: Chase Bank
Account Number: XXXX1234
Account Type: Credit Card
Status: Pays As Agreed
Date Opened: 01/10/2020
Balance: $1,200
Credit Limit: $5,000
Past Due: $0
Creditor: ABC Collections
Account Number: XXXX9988
Account Type: Collection
Status: Collection
Balance: $300
Past Due: $300
Inquiry: Example Auto Finance
Date: 05/01/2026
`);

    const result = await service.importCreditReport({ filename: 'equifax-report.pdf', content: pdf });
    expect(result).toMatchObject({
      ok: true,
      status: 'processed',
      report: {
        bureau: 'equifax',
        score: 712,
        accounts: 2,
        delinquentAccounts: 1,
        inquiries: 1,
      },
    });
    const overview = service.getCreditOverview();
    expect(overview.accounts.map((account) => account.creditor)).toEqual(['Chase Bank', 'ABC Collections']);
    expect(overview.utilization?.overallUtilizationPercent).toBe(24);
    expect(overview.suggestions.some((item) => item.creditor === 'ABC Collections')).toBe(true);
    expect(service.generateCreditDisputeLetter({
      creditor: 'ABC Collections',
      accountMask: '*9988',
      reason: 'This collection balance is inaccurate.',
      bureau: 'equifax',
    }).letter).toContain('This collection balance is inaccurate.');
    service.close();
  });
});
