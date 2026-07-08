import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FinanceService } from '../src/application/finance-service.js';
import { startHttpServer } from '../src/http/server.js';
import { LocalModelEngine } from '../src/infrastructure/local-model.js';
import { CsvStatementParser } from '../src/infrastructure/parsers/csv-parser.js';
import { OfxStatementParser } from '../src/infrastructure/parsers/ofx-parser.js';
import { SqliteFinanceRepository } from '../src/infrastructure/sqlite-repository.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

// Recency-window rules match on the transaction date against the real clock, so
// fixtures for them are dated relative to now rather than hardcoded (which would rot).
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function httpFixture(options: { desktopToken?: string; onDesktopShutdown?: () => void } = {}) {
  const service = new FinanceService(
    new SqliteFinanceRepository(':memory:'),
    [new OfxStatementParser(), new CsvStatementParser()],
    new LocalModelEngine(join(tmpdir(), 'finora-test-models-missing')),
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

  it('serves the web app shell for direct section URLs', async () => {
    const { base } = await httpFixture();
    const response = await fetch(`${base}/credit`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="root"></div>');
  });

  it('imports credit reports and exposes credit overview tools', async () => {
    const { base } = await httpFixture();
    const creditReport = await fetch(`${base}/v1/credit-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'equifax-report.pdf',
        contentBase64: Buffer.from(`%PDF-1.7
Equifax Credit Report
Report Date: 06/15/2026
VantageScore 3.0 701
Creditor: Chase Bank
Account Number: XXXX1234
Account Type: Credit Card
Status: Open
Balance: $500
Credit Limit: $2,000
Inquiry: Example Bank
Date: 05/01/2026
`).toString('base64'),
      }),
    });
    expect(creditReport.status).toBe(200);
    const imported = await creditReport.json();
    expect(imported).toMatchObject({
      ok: true,
      status: 'processed',
      report: { bureau: 'equifax', accounts: 1, inquiries: 1 },
    });

    const overview = await fetch(`${base}/v1/credit-reports`);
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({
      hasData: true,
      accounts: [{ creditor: 'Chase Bank', accountMask: '*1234' }],
      utilization: { overallUtilizationPercent: 25 },
    });

    const letter = await fetch(`${base}/v1/credit-reports/dispute-letter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creditor: 'Chase Bank',
        accountMask: '*1234',
        reason: 'The balance is incorrect.',
        bureau: 'equifax',
      }),
    });
    expect(letter.status).toBe(200);
    const deleted = await fetch(`${base}/v1/credit-reports/${imported.report.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ ok: true, hasData: false, reports: [] });
    const missingDelete = await fetch(`${base}/v1/credit-reports/${imported.report.id}`, { method: 'DELETE' });
    expect(missingDelete.status).toBe(404);
    expect(await letter.json()).toMatchObject({ creditor: 'Chase Bank' });

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

  it('does not expose a Plaid Item removal endpoint', async () => {
    const { base } = await httpFixture();
    const response = await fetch(`${base}/v1/plaid/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: 'item' }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'route_not_found' } });
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

  it('previews and saves generated rules', async () => {
    const { base } = await httpFixture();
    const preview = await fetch(`${base}/v1/rules/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Generate a weekly rule for large brokerage cash drag before a digest.',
      }),
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody).toMatchObject({
      text: 'Generate a weekly rule for large brokerage cash drag before a digest.',
      kind: 'idle-brokerage-cash',
      domain: 'investments',
      scope: 'brokerage',
      cadence: 'weekly',
      scheduledHour: 9,
      executionClass: 'D',
    });
    expect(previewBody.channel).toBe('auto');

    const saved = await fetch(`${base}/v1/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Generate a daily rule that flags high credit utilization.',
        scope: 'credit',
        cadence: 'daily',
        channel: 'digest',
        scheduledHour: 9,
      }),
    });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({
      kind: 'credit-utilization',
      domain: 'credit',
      executionClass: 'D',
      actionTier: 'advisor',
      sourceText: 'Generate a daily rule that flags high credit utilization.',
      scope: 'credit',
      cadence: 'daily',
      channel: 'auto',
      scheduledHour: 9,
      enabled: true,
    });
  });

  it('files a saved rule under its definition domain (single-table: domain is definition-owned)', async () => {
    const { base } = await httpFixture();
    const saved = await fetch(`${base}/v1/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'flag large transactions', scope: 'banking', cadence: 'event' }),
    });
    expect(saved.status).toBe(201);
    // Kind is inferred from the text; the rule's domain follows its shared
    // definition (large-transaction is a spending rule) rather than a per-user override.
    expect(await saved.json()).toMatchObject({ kind: 'large-transaction', domain: 'spending' });
  });

  it('lists active findings ranked with dollar impact and confidence', async () => {
    const { base } = await httpFixture();
    const account = await createAccount(base, {
      name: 'Rewards Credit Card',
      type: 'credit',
    });
    const rule = await fetch(`${base}/v1/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'flag large transactions',
        scope: 'banking',
        cadence: 'event',
      }),
    });
    expect(rule.status).toBe(201);
    const imported = await fetch(`${base}/v1/imports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        filename: 'card.csv',
        // A prior charge at the same merchant keeps the enabled-by-default
        // unfamiliar-merchant rule quiet, so this asserts on the large-transaction finding.
        contentBase64: Buffer.from(`Date,Description,Amount\n${daysAgo(70)},Coffee Shop,-20.00\n${daysAgo(3)},Coffee Shop,-600.00\n`).toString('base64'),
      }),
    });
    expect(imported.status).toBe(200);

    const findings = await fetch(`${base}/v1/findings`);
    expect(findings.status).toBe(200);
    expect(await findings.json()).toMatchObject({
      items: [
        expect.objectContaining({
          title: 'Large transaction: Coffee Shop',
          value: '-$600.00',
          dollarImpactMinor: 60000,
          confidence: 0.5,
        }),
      ],
    });
  });

  it('persists a weekly rule schedule day and hour', async () => {
    const { base } = await httpFixture();
    const saved = await fetch(`${base}/v1/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'weekly idle cash review', scope: 'banking', cadence: 'weekly', scheduledHour: 9, scheduledDay: 1 }),
    });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ kind: 'idle-cash', cadence: 'weekly', scheduledHour: 9, scheduledDay: 1 });
    // /v1/rules lists every rule; find the one we just scheduled by its kind.
    const listed = await (await fetch(`${base}/v1/rules`)).json() as { items: Array<{ kind: string; scheduledDay: number | null }> };
    expect(listed.items.find((r) => r.kind === 'idle-cash')).toMatchObject({ scheduledDay: 1 });
  });

  it('ships every rule enabled and active by default', async () => {
    const { base } = await httpFixture();
    const listed = await (await fetch(`${base}/v1/rules`)).json() as { items: Array<{ enabled: boolean; active: boolean }> };
    expect(listed.items.length).toBeGreaterThanOrEqual(29);
    expect(listed.items.every((r) => r.enabled && r.active)).toBe(true);
  });

  it('toggles a rule off and on and updates its schedule, all by kind', async () => {
    const { base } = await httpFixture();
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const activeOf = async (kind: string) => {
      const listed = await (await fetch(`${base}/v1/rules`)).json() as { items: Array<{ kind: string; active: boolean }> };
      return listed.items.find((r) => r.kind === kind)?.active;
    };

    // Toggle off, reflected in the list.
    const off = await post('/v1/rules/toggle', { kind: 'idle-cash', enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ kind: 'idle-cash', active: false });
    expect(await activeOf('idle-cash')).toBe(false);

    // Toggle back on.
    await post('/v1/rules/toggle', { kind: 'idle-cash', enabled: true });
    expect(await activeOf('idle-cash')).toBe(true);

    // Update the delivery schedule by kind (leaves it on).
    const sched = await post('/v1/rules/schedule', { kind: 'idle-cash', cadence: 'monthly', scheduledHour: 8, scheduledDay: 3 });
    expect(sched.status).toBe(200);
    expect(await sched.json()).toMatchObject({ kind: 'idle-cash', cadence: 'monthly', scheduledHour: 8, scheduledDay: 3, active: true });

    // An unknown kind is a 404, not a silent success.
    expect((await post('/v1/rules/toggle', { kind: 'no-such-rule', enabled: false })).status).toBe(404);
  });

  it('turns a fact-dependent rule into a question, then unlocks it once the fact is saved', async () => {
    const { base } = await httpFixture();
    await fetch(`${base}/v1/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'check my 401k employer match', scope: 'all', cadence: 'monthly' }),
    });
    const pending = await (await fetch(`${base}/v1/questions`)).json() as { items: Array<{ factKey: string }> };
    expect(pending.items.map((q) => q.factKey)).toContain('retirement.employer_match_pct');

    for (const [key, value] of [['income.gross_annual', '120000'], ['retirement.contribution_pct', '3'], ['retirement.employer_match_pct', '6']]) {
      const res = await fetch(`${base}/v1/facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      expect(res.status).toBe(201);
    }
    const cleared = await (await fetch(`${base}/v1/questions`)).json() as { items: unknown[] };
    expect(cleared.items).toHaveLength(0);
    const findings = await (await fetch(`${base}/v1/findings`)).json() as { items: Array<{ kind: string; dollarImpactMinor: number }> };
    expect(findings.items.find((f) => f.kind === 'employer-match')).toMatchObject({ dollarImpactMinor: 360000 });
  });

  it('reports fact-gated rules and their unanswered facts via /v1/facts/needs', async () => {
    const { base } = await httpFixture();
    // employer-match is alwaysOn, so its needs surface without creating any rule.
    const needs = await (await fetch(`${base}/v1/facts/needs`)).json() as {
      byKind: Record<string, { facts: Array<{ key: string; satisfied: boolean; expects: string }> }>;
      pending: Array<{ key: string; expects: string }>;
    };
    const match = needs.byKind['employer-match'];
    expect(match).toBeTruthy();
    expect(match?.facts.every((f) => !f.satisfied)).toBe(true);
    expect(needs.pending.map((p) => p.key)).toContain('retirement.employer_match_pct');
    expect(needs.pending.find((p) => p.key === 'retirement.employer_match_pct')?.expects).toBe('percent');
  });

  it('normalizes messy fact answers and marks the need satisfied', async () => {
    const { base } = await httpFixture();
    const answer = (key: string, value: string) => fetch(`${base}/v1/facts/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    // The built-in model is the default in tests, so the deterministic parser runs.
    expect(await (await answer('retirement.employer_match_pct', 'about 6 %')).json()).toMatchObject({ value: '6', source: 'user' });
    expect(await (await answer('income.gross_annual', '$120,000')).json()).toMatchObject({ value: '120000' });

    const needs = await (await fetch(`${base}/v1/facts/needs`)).json() as {
      byKind: Record<string, { facts: Array<{ key: string; satisfied: boolean }> }>;
      pending: Array<{ key: string }>;
    };
    const facts = needs.byKind['employer-match']?.facts ?? [];
    expect(facts.find((f) => f.key === 'retirement.employer_match_pct')?.satisfied).toBe(true);
    expect(facts.find((f) => f.key === 'income.gross_annual')?.satisfied).toBe(true);
    const pendingKeys = needs.pending.map((p) => p.key);
    expect(pendingKeys).toContain('retirement.contribution_pct');
    expect(pendingKeys).not.toContain('retirement.employer_match_pct');
  });

  it('exposes a rule-feed sync route that reports when no feed is configured', async () => {
    const { base } = await httpFixture();
    const res = await fetch(`${base}/v1/rules/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    // No RULES_FEED_URL set, so the sync is a reported no-op rather than an error.
    expect(await res.json()).toMatchObject({ skipped: true, reason: 'no-feed-url' });
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
