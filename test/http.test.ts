import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FinanceService } from '../src/application/finance-service.js';
import { startHttpServer } from '../src/http/server.js';
import { CsvStatementParser } from '../src/infrastructure/parsers/csv-parser.js';
import { OfxStatementParser } from '../src/infrastructure/parsers/ofx-parser.js';
import { SqliteFinanceRepository } from '../src/infrastructure/sqlite-repository.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function httpFixture(options: { desktopToken?: string; onDesktopShutdown?: () => void } = {}) {
  const service = new FinanceService(
    new SqliteFinanceRepository(':memory:'),
    [new OfxStatementParser(), new CsvStatementParser()],
  );
  const server = startHttpServer(service, { host: '127.0.0.1', port: 0, ...options });
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
  });
  return { base: `http://127.0.0.1:${port}` };
}

async function createAccount(base: string, input: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/v1/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ institution: 'Example Bank', name: 'Checking', ...input }),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get('location')).toMatch(/^\/v1\/accounts\//);
  return await response.json() as { id: string };
}

describe('HTTP API', () => {
  it('creates accounts, imports statements, and deletes local accounts', async () => {
    const { base } = await httpFixture();
    const account = await createAccount(base);
    const csv = Buffer.from('Date,Description,Amount\n2026-06-01,Deposit,100.00\n');

    const imported = await fetch(`${base}/v1/imports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        filename: 'statement.csv',
        contentBase64: csv.toString('base64'),
      }),
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ insertedCount: 1 });

    const removed = await fetch(`${base}/v1/accounts/${account.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ ok: true });
    expect((await fetch(`${base}/v1/accounts/${account.id}`)).status).toBe(404);
  });

  it('validates credit report uploads and returns one error envelope', async () => {
    const { base } = await httpFixture();
    const creditReport = await fetch(`${base}/v1/credit-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'equifax-report.pdf',
        contentBase64: Buffer.from('%PDF-1.7\ncredit report').toString('base64'),
      }),
    });
    expect(creditReport.status).toBe(200);
    expect(await creditReport.json()).toMatchObject({ ok: true, status: 'processed' });

    const wrongCreditFile = await fetch(`${base}/v1/credit-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'bank-statement.csv',
        contentBase64: Buffer.from('Date,Amount\n2026-06-01,1.00').toString('base64'),
      }),
    });
    expect(wrongCreditFile.status).toBe(415);
    expect(await wrongCreditFile.json()).toMatchObject({ error: { code: 'unsupported_format' } });
  });

  it('uses honest status codes for missing and invalid requests', async () => {
    const { base } = await httpFixture();
    const missing = await fetch(`${base}/v1/accounts/00000000-0000-4000-8000-000000000000`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: 'not_found', message: 'Account not found' },
    });

    const invalid = await fetch(`${base}/v1/transactions?limit=1000`);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('blocks direct deletion of provider-managed accounts', async () => {
    const { base } = await httpFixture();
    const providerAccount = await createAccount(base, {
      institution: 'Provider Bank',
      source: 'plaid',
      providerAccountId: 'plaid-account-1',
    });
    const providerDelete = await fetch(`${base}/v1/accounts/${providerAccount.id}`, { method: 'DELETE' });
    expect(providerDelete.status).toBe(422);
    expect(await providerDelete.json()).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('reports missing connector credentials without external calls', async () => {
    const { base } = await httpFixture();
    const plaidLink = await fetch(`${base}/v1/plaid/link-token`, { method: 'POST' });
    expect(plaidLink.status).toBe(422);
    expect(await plaidLink.json()).toMatchObject({ error: { code: 'invalid_input', message: 'Save a Plaid Client ID and secret first.' } });

    const telegramConnect = await fetch(`${base}/v1/telegram/connect`, { method: 'POST' });
    expect(telegramConnect.status).toBe(422);
    expect(await telegramConnect.json()).toMatchObject({
      error: { code: 'invalid_input', message: 'Save a Telegram bot token first.' },
    });
  });

  it('protects desktop data routes with the session token', async () => {
    let shutdownRequested = false;
    const { base } = await httpFixture({
      desktopToken: 'desktop-test-token',
      onDesktopShutdown: () => { shutdownRequested = true; },
    });

    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
    const denied = await fetch(`${base}/v1/accounts`);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const allowed = await fetch(`${base}/v1/accounts`, {
      headers: { 'X-Finora-Desktop-Token': 'desktop-test-token' },
    });
    expect(allowed.status).toBe(200);
    const shutdown = await fetch(`${base}/v1/desktop/shutdown`, {
      method: 'POST',
      headers: { 'X-Finora-Desktop-Token': 'desktop-test-token' },
    });
    expect(shutdown.status).toBe(204);
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdownRequested).toBe(true);
  });
});
