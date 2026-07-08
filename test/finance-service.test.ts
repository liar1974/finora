import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceService, enrichCreditExtractionWithLlm } from '../src/application/finance-service.js';
import type { RecurringClassifier } from '../src/application/ports.js';
import { LocalModelEngine } from '../src/infrastructure/local-model.js';
import { CsvStatementParser } from '../src/infrastructure/parsers/csv-parser.js';
import { OfxStatementParser } from '../src/infrastructure/parsers/ofx-parser.js';
import { SqliteFinanceRepository } from '../src/infrastructure/sqlite-repository.js';

afterEach(() => vi.unstubAllGlobals());

// Recency-window rules (large-transaction, executed-trades, duplicate-charge, …)
// filter on the transaction date against the real clock, so fixtures must be dated
// relative to now — a hardcoded date would silently fall out of the window and rot
// the test weeks later.
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// A models dir that will never contain weights, so the built-in engine reports
// the model as absent without touching the native runtime.
function localModel() {
  return new LocalModelEngine(join(tmpdir(), 'finora-test-models-missing'));
}

// A deterministic stand-in for the LLM recurring classifier: recognizes a few
// known recurring payees by name and rejects everything else (Uber, duty-free,
// one-off shops). Injecting it also marks the model as "available", so recurring
// rules and the table run without a real model.
const recurringNames = /netflix|spotify|acme|payroll|clipper|visible|hulu|gym|verizon|kikoff/;
const fakeRecurringClassifier: RecurringClassifier = async (candidates) =>
  candidates.map((candidate) => {
    const name = candidate.label.toLowerCase();
    const isRecurring = recurringNames.test(name);
    const kind = !isRecurring
      ? null
      : candidate.direction === 'in'
        ? 'income'
        : /kikoff/.test(name)
          ? 'loan'
          : /clipper|visible|verizon/.test(name)
            ? 'bill'
            : 'subscription';
    // Collapse Kikoff's varying reference-code descriptions to one canonical payee
    // (mirrors what the real model is prompted to do), so fragments merge.
    const canonicalName = /kikoff/.test(name) ? 'Kikoff' : candidate.label;
    return {
      merchant: candidate.merchant,
      direction: candidate.direction,
      isRecurring,
      kind,
      cadence: 'monthly',
      canonicalName,
      confidence: 0.9,
    };
  });

function application(classifier?: RecurringClassifier) {
  return new FinanceService(
    new SqliteFinanceRepository(':memory:'),
    [new OfxStatementParser(), new CsvStatementParser()],
    localModel(),
    undefined,
    classifier,
  );
}

describe('FinanceService', () => {
  it('delivers each active insight to Telegram once until it resolves', async () => {
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
    const service = new FinanceService(repository, [new OfxStatementParser(), new CsvStatementParser()], localModel());
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: {} });
    }));

    await expect(service.deliverInsightsToIm()).resolves.toMatchObject({ count: 1, sent: true });
    await expect(service.deliverInsightsToIm()).resolves.toMatchObject({ count: 0, sent: false, reason: 'no-new-insights' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Example Bank connection needs review');
    service.close();
  });

  it('surfaces a large-transaction finding with dollar impact and confidence, delivering it once', async () => {
    const repository = new SqliteFinanceRepository(':memory:');
    repository.saveAppSettings({
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHAT_ID: '123',
      NOTIFICATION_CHANNEL: 'telegram',
    });
    const service = new FinanceService(repository, [new OfxStatementParser(), new CsvStatementParser()], localModel());
    service.createRule({
      text: 'flag large transactions',
      scope: 'banking',
      cadence: 'event',
      channel: 'telegram',
    });
    const account = service.createAccount({
      institution: 'Example Bank',
      name: 'Rewards Credit Card',
      type: 'credit',
      currency: 'USD',
    });
    service.importStatement({
      accountId: account.id,
      filename: 'card.csv',
      content: Buffer.from(`Date,Description,Amount\n${daysAgo(3)},Coffee Shop,-600.00\n`),
    });
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: {} });
    }));

    expect(service.listFindings()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Large transaction: Coffee Shop',
        value: '-$600.00',
        dollarImpactMinor: 60000,
        confidence: 0.5,
      }),
    ]));
    await expect(service.deliverInsightsToIm()).resolves.toMatchObject({ count: 1, sent: true });
    await expect(service.deliverInsightsToIm()).resolves.toMatchObject({ count: 0, sent: false, reason: 'no-new-insights' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Large transaction: Coffee Shop');
    expect(sent[0]?.text).toContain('Rewards Credit Card');
    service.close();
  });

  it('surfaces a recently executed brokerage order even when its row predates the rule', () => {
    const repository = new SqliteFinanceRepository(':memory:');
    const service = new FinanceService(repository, [new OfxStatementParser(), new CsvStatementParser()], localModel());
    const account = service.createAccount({ institution: 'Robinhood', name: 'Brokerage', type: 'brokerage', currency: 'USD' });
    // Ingest the order BEFORE the rule exists, so its row is older than the rule —
    // exactly the copied-data case a created_at gate wrongly excluded. The rule keys
    // off the trade date, so a recent order still surfaces.
    repository.saveProviderBrokerageTransactions([{
      accountId: account.id,
      sourceId: 'trade-1',
      date: daysAgo(2),
      description: 'AAPL buy',
      amountMinor: -300000,
      currency: 'USD',
      symbol: 'AAPL',
      investmentType: 'buy',
      fingerprint: 'trade:aapl',
    }]);
    service.createRule({ text: 'any new brokerage executed order', scope: 'brokerage', cadence: 'event' });

    const finding = service.listFindings().find((f) => f.kind === 'executed-trades');
    expect(finding?.title).toBe('Bought AAPL');
    expect(finding?.value).toBe('$3,000.00');
    service.close();
  });

  it('does not re-notify when a pending charge posts (Plaid pending→posted)', async () => {
    const repository = new SqliteFinanceRepository(':memory:');
    repository.saveAppSettings({
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHAT_ID: '123',
      NOTIFICATION_CHANNEL: 'telegram',
    });
    const service = new FinanceService(repository, [new OfxStatementParser(), new CsvStatementParser()], localModel());
    service.createRule({ text: 'flag large transactions', scope: 'banking', cadence: 'event' });
    const account = service.createAccount({
      institution: 'Robinhood',
      name: 'Robinhood Credit Card',
      type: 'credit',
      currency: 'USD',
    });
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, result: {} });
    }));

    // Pending charge arrives and is notified once.
    repository.reconcileProviderTransactions([{
      accountId: account.id,
      sourceId: 'plaid-pending',
      date: daysAgo(3),
      description: '99 Ranch Market',
      amountMinor: -60000,
      currency: 'USD',
      pending: true,
      fingerprint: 'plaid:pending',
    }]);
    await expect(service.deliverInsightsToIm()).resolves.toMatchObject({ count: 1, sent: true });

    // It posts under a new transaction_id with a shifted date; supersede in place.
    const reconciled = repository.reconcileProviderTransactions([{
      accountId: account.id,
      sourceId: 'plaid-posted',
      date: daysAgo(4),
      description: '99 Ranch Market',
      amountMinor: -60000,
      currency: 'USD',
      pending: false,
      fingerprint: 'plaid:posted',
      supersedesFingerprint: 'plaid:pending',
    }]);

    expect(reconciled).toMatchObject({ inserted: 0, updated: 1 });
    await expect(service.deliverInsightsToIm()).resolves.toMatchObject({ count: 0, sent: false, reason: 'no-new-insights' });
    expect(sent).toHaveLength(1);

    // The ledger keeps a single, posted entry — no duplicate row.
    const rows = service.listTransactions({ accountId: account.id }).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: daysAgo(4), pending: false, sourceId: 'plaid-posted' });
    service.close();
  });

  it('reconcileProviderTransactions preserves the row id and deleteTransactionsByFingerprints removes rows', () => {
    const repository = new SqliteFinanceRepository(':memory:');
    const account = repository.createAccount({
      institution: 'Robinhood',
      name: 'Robinhood Credit Card',
      type: 'credit',
      currency: 'USD',
      domain: 'bank',
      source: 'plaid',
      providerAccountId: 'acct-1',
      metadata: {},
    });
    repository.reconcileProviderTransactions([{
      accountId: account.id,
      sourceId: 'x',
      date: '2026-07-01',
      description: 'Clipper Mobile',
      amountMinor: -5500,
      currency: 'USD',
      pending: true,
      fingerprint: 'plaid:x',
    }]);
    const before = repository.listTransactions({ accountId: account.id, limit: 50 }).items;
    expect(before).toHaveLength(1);
    const originalId = before[0]!.id;

    repository.reconcileProviderTransactions([{
      accountId: account.id,
      sourceId: 'y',
      date: '2026-07-01',
      description: 'Clipper Mobile',
      amountMinor: -5500,
      currency: 'USD',
      pending: false,
      fingerprint: 'plaid:y',
      supersedesFingerprint: 'plaid:x',
    }]);
    const after = repository.listTransactions({ accountId: account.id, limit: 50 }).items;
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(originalId);
    expect(after[0]).toMatchObject({ pending: false, sourceId: 'y' });

    expect(repository.deleteTransactionsByFingerprints(account.id, ['plaid:y'])).toBe(1);
    expect(repository.listTransactions({ accountId: account.id, limit: 50 }).items).toHaveLength(0);
    expect(repository.deleteTransactionsByFingerprints(account.id, [])).toBe(0);
    repository.close();
  });

  it('produces insights for non-transaction rule kinds', () => {
    const repository = new SqliteFinanceRepository(':memory:');
    const service = new FinanceService(repository, [new OfxStatementParser(), new CsvStatementParser()], localModel());
    service.createRule({ text: 'connection sync health', scope: 'all', cadence: 'event' });
    service.createRule({ text: 'large brokerage cash drag', scope: 'brokerage', cadence: 'weekly' });
    service.createRule({ text: 'portfolio concentration', scope: 'brokerage', cadence: 'weekly' });
    service.createRule({ text: 'credit utilization', scope: 'credit', cadence: 'daily' });
    repository.saveProviderConnection({
      provider: 'plaid',
      externalId: 'needs-review',
      institution: 'Example Bank',
      status: 'error',
    });
    const brokerage = service.createAccount({
      institution: 'Broker',
      name: 'Investing',
      type: 'brokerage',
      currency: 'USD',
      domain: 'brokerage',
    });
    const credit = service.createAccount({
      institution: 'Example Bank',
      name: 'Rewards Credit Card',
      type: 'credit',
      currency: 'USD',
    });
    repository.saveProviderBalances([
      {
        accountId: brokerage.id,
        asOfDate: '2026-07-01',
        currentMinor: 1000000,
        cashMinor: 400000,
        currency: 'USD',
        fingerprint: 'balance:brokerage',
      },
      {
        accountId: credit.id,
        asOfDate: '2026-07-01',
        currentMinor: 350000,
        limitMinor: 1000000,
        currency: 'USD',
        fingerprint: 'balance:credit',
      },
    ]);
    repository.saveProviderHoldings([
      {
        accountId: brokerage.id,
        asOfDate: '2026-07-01',
        symbol: 'AAPL',
        valueMinor: 300000,
        currency: 'USD',
        fingerprint: 'holding:aapl',
      },
      {
        accountId: brokerage.id,
        asOfDate: '2026-07-01',
        symbol: 'BND',
        valueMinor: 700000,
        currency: 'USD',
        fingerprint: 'holding:bnd',
      },
    ]);

    const findings = service.listFindings();
    const titles = findings.map((finding) => finding.title);
    expect(titles).toEqual(expect.arrayContaining([
      'Example Bank connection needs review',
      'Investing cash drag',
      'BND concentration',
      'Rewards Credit Card utilization is elevated',
    ]));
    expect(findings.filter((finding) => finding.ruleId).map((finding) => finding.title)).toEqual(expect.arrayContaining([
      'Example Bank connection needs review',
      'Investing cash drag',
      'BND concentration',
      'Rewards Credit Card utilization is elevated',
    ]));
    service.close();
  });

  it('gates a fact-dependent rule behind ranked questions, then unlocks a finding once facts are provided', () => {
    const service = application();
    service.createRule({ text: 'check my 401k employer match', scope: 'all', cadence: 'monthly' });

    // Blocked on missing facts: no finding, but questions ranked by unlockable impact.
    expect(service.listFindings().some((f) => f.kind === 'employer-match')).toBe(false);
    const questions = service.listQuestions();
    expect(questions.map((q) => q.factKey).sort()).toEqual(['income.gross_annual', 'retirement.contribution_pct', 'retirement.employer_match_pct']);
    expect(questions.every((q) => q.unlockImpactMinor > 0)).toBe(true);

    service.saveFact({ key: 'income.gross_annual', value: '120000' });
    service.saveFact({ key: 'retirement.contribution_pct', value: '3' });
    service.saveFact({ key: 'retirement.employer_match_pct', value: '6' });

    expect(service.listQuestions()).toHaveLength(0);
    const finding = service.listFindings().find((f) => f.kind === 'employer-match');
    // 6% match minus 3% contribution on $120k = $3,600/yr; user-entered facts cap the tier at advisor.
    expect(finding).toMatchObject({ dollarImpactMinor: 360000, confidence: 0.7, actionTier: 'advisor' });
    service.close();
  });

  it('downloads rules from a versioned feed and surfaces any user input they need', async () => {
    const repository = new SqliteFinanceRepository(':memory:');
    repository.saveAppSettings({ RULES_FEED_URL: 'http://feed.test/rules.json' });
    const feedV1 = {
      version: 1,
      specs: [{
        kind: 'commute-cost',
        domain: 'spending',
        executionClass: 'D',
        actionTier: 'advisor',
        scope: 'banking',
        cadence: 'monthly',
        alwaysOn: true,
        keywords: 'commute',
        sql: "SELECT 'commute' AS key, 'x' AS title, 'x' AS detail, 'x' AS value, 0.5 AS confidence, '' AS evidence_summary, '' AS evidence_records, :now_iso AS created_at WHERE 0",
        prompt: null,
        facts: [{ key: 'commute.monthly_cost_minor', prompt: 'What do you spend on commuting per month?', unlockImpactMinor: 50000, expects: 'currency' }],
        enabled: true,
        version: 1,
      }],
    };
    let feedBody = JSON.stringify(feedV1);
    const service = new FinanceService(
      repository,
      [new OfxStatementParser(), new CsvStatementParser()],
      localModel(),
      { fetchFeed: async () => feedBody },
    );

    // A newer feed version applies its specs as `downloaded` rules — no code, no redeploy.
    expect(await service.syncRuleFeed()).toMatchObject({ applied: 1, skipped: false, version: 1 });
    expect(repository.listRuleSpecs().find((s) => s.kind === 'commute-cost')).toMatchObject({ source: 'downloaded', domain: 'spending' });

    // The downloaded rule declares a fact, so it flows straight into the needs-input surface.
    const needs = service.factNeeds();
    expect(needs.byKind['commute-cost']).toBeTruthy();
    expect(needs.pending.map((p) => p.key)).toContain('commute.monthly_cost_minor');
    expect(service.listQuestions().map((q) => q.factKey)).toContain('commute.monthly_cost_minor');

    // Re-syncing the same version is a no-op.
    expect(await service.syncRuleFeed()).toMatchObject({ applied: 0, skipped: true, version: 1 });

    // A newer version re-applies the changed spec in place.
    feedBody = JSON.stringify({ ...feedV1, version: 2, specs: [{ ...feedV1.specs[0], keywords: 'commute|transit' }] });
    expect(await service.syncRuleFeed()).toMatchObject({ applied: 1, skipped: false, version: 2 });
    expect(repository.listRuleSpecs().find((s) => s.kind === 'commute-cost')?.keywords).toBe('commute|transit');

    service.close();
  });

  it('skips feed sync without a configured URL and rejects a malformed feed', async () => {
    const repository = new SqliteFinanceRepository(':memory:');
    const feedBody = 'not json at all';
    const service = new FinanceService(
      repository,
      [new OfxStatementParser(), new CsvStatementParser()],
      localModel(),
      { fetchFeed: async () => feedBody },
    );

    expect(await service.syncRuleFeed()).toMatchObject({ skipped: true, reason: 'no-feed-url' });

    repository.saveAppSettings({ RULES_FEED_URL: 'http://feed.test/rules.json' });
    await expect(service.syncRuleFeed()).rejects.toThrow();

    service.close();
  });

  it('detects a subscription price increase and annualizes the delta', async () => {
    const service = application(fakeRecurringClassifier);
    service.createRule({ text: 'flag subscription price increases', scope: 'banking', cadence: 'weekly' });
    const account = service.createAccount({ institution: 'Example Bank', name: 'Checking', type: 'checking', currency: 'USD' });
    service.importStatement({
      accountId: account.id,
      filename: 'subs.csv',
      content: Buffer.from(
        'Date,Description,Amount\n2026-03-05,ACME STREAMING,-60.00\n2026-04-05,ACME STREAMING,-60.00\n2026-05-05,ACME STREAMING,-60.00\n2026-06-05,ACME STREAMING,-80.00\n',
      ),
    });
    await service.refreshRecurringClassifications();
    const finding = service.listFindings().find((f) => f.kind === 'subscription-price-increase');
    expect(finding?.title).toContain('ACME STREAMING');
    // $20/mo more, annualized to roughly $240; surfaces above the suppression floor.
    expect(finding && finding.dollarImpactMinor >= 20000).toBe(true);
    service.close();
  });

  it('flags the same subscription billed across two accounts', async () => {
    const service = application(fakeRecurringClassifier);
    const monthly = (name: string) =>
      `Date,Description,Amount\n2026-03-08,${name},-11.99\n2026-04-08,${name},-11.99\n2026-05-08,${name},-11.99\n2026-06-08,${name},-11.99\n`;
    for (const card of ['Card A', 'Card B']) {
      const account = service.createAccount({ institution: 'Example Bank', name: card, type: 'credit', currency: 'USD' });
      service.importStatement({ accountId: account.id, filename: `${card}.csv`, content: Buffer.from(monthly('SPOTIFY')) });
    }
    await service.refreshRecurringClassifications();
    const finding = service.listFindings().find((f) => f.kind === 'cross-card-subscription');
    expect(finding?.title).toContain('SPOTIFY');
    expect(finding && finding.dollarImpactMinor > 0).toBe(true);
    service.close();
  });

  it('classifies recurring by merchant, not by repetition — Uber and duty-free are excluded', async () => {
    const service = application(fakeRecurringClassifier);
    service.createRule({ text: 'recurring subscriptions', scope: 'banking', cadence: 'monthly' });
    const account = service.createAccount({ institution: 'Example Bank', name: 'Checking', type: 'checking', currency: 'USD' });
    const row = (desc: string, day: number, amount: string) => `${daysAgo(day)},${desc},${amount}`;
    service.importStatement({
      accountId: account.id,
      filename: 'mix.csv',
      content: Buffer.from(
        ['Date,Description,Amount',
          // A real subscription: fixed price, monthly.
          row('NETFLIX', 92, '-15.99'), row('NETFLIX', 61, '-15.99'), row('NETFLIX', 31, '-15.99'), row('NETFLIX', 1, '-15.99'),
          // Ride-hailing: sporadic timing, varying amounts — a familiar merchant, not a subscription.
          row('UBER', 90, '-12.40'), row('UBER', 88, '-33.10'), row('UBER', 20, '-8.90'), row('UBER', 5, '-56.00'),
          // A transit card reloaded at varying amounts — recurring even though the amount drifts.
          row('CLIPPER', 75, '-20.00'), row('CLIPPER', 45, '-40.00'), row('CLIPPER', 15, '-25.00'),
          // Two one-off duty-free trips.
          row('DUTY ZERO BY CDF', 40, '-420.00'), row('DUTY ZERO BY CDF', 10, '-185.00'),
          // A regular paycheck (income).
          row('CHASE PAYROLL', 84, '251.00'), row('CHASE PAYROLL', 70, '251.00'), row('CHASE PAYROLL', 56, '251.00'),
          row('CHASE PAYROLL', 42, '251.00'), row('CHASE PAYROLL', 28, '251.00'), row('CHASE PAYROLL', 14, '251.00'),
          ''].join('\n'),
      ),
    });
    await service.refreshRecurringClassifications();

    const recurring = await service.listRecurring();
    if (recurring.status !== 'ok') throw new Error(`expected ok, got ${recurring.status}`);
    const merchants = recurring.items.map((item) => item.merchant.toUpperCase());
    expect(merchants).toContain('NETFLIX');
    expect(merchants).toContain('CLIPPER');
    expect(merchants).toContain('CHASE PAYROLL');
    expect(merchants).not.toContain('UBER');
    expect(merchants.some((m) => m.includes('DUTY ZERO'))).toBe(false);
    // Income and bills carry their classified kind; only true subscriptions surface as the Subscription finding.
    expect(recurring.items.find((i) => i.merchant.toUpperCase() === 'CHASE PAYROLL')?.direction).toBe('in');

    const subs = service.listFindings().filter((f) => f.kind === 'recurring-subscriptions').map((f) => f.title);
    expect(subs.some((t) => t.includes('NETFLIX'))).toBe(true);
    expect(subs.some((t) => t.includes('UBER'))).toBe(false);
    expect(subs.some((t) => t.includes('CLIPPER'))).toBe(false); // a bill, not a subscription
    service.close();
  });

  it('does not guess recurring transactions when no model is configured', async () => {
    const service = application(); // no classifier, built-in model has no weights
    const account = service.createAccount({ institution: 'Example Bank', name: 'Checking', type: 'checking', currency: 'USD' });
    service.importStatement({
      accountId: account.id,
      filename: 'nf.csv',
      content: Buffer.from('Date,Description,Amount\n2026-04-01,NETFLIX,-15.99\n2026-05-01,NETFLIX,-15.99\n2026-06-01,NETFLIX,-15.99\n'),
    });
    const recurring = await service.listRecurring();
    expect(recurring.status).toBe('model_required');
    service.close();
  });

  it('merges a payees varying descriptions into one row and attaches every transaction', async () => {
    const service = application(fakeRecurringClassifier);
    const account = service.createAccount({ institution: 'Example Bank', name: 'Checking', type: 'checking', currency: 'USD' });
    const row = (desc: string, day: number, amount: string) => `${daysAgo(day)},${desc},${amount}`;
    // The same Kikoff loan, billed under different reference-code descriptions —
    // deterministic grouping would split these into separate 2-count rows.
    service.importStatement({
      accountId: account.id,
      filename: 'kikoff.csv',
      content: Buffer.from(
        ['Date,Description,Amount',
          row('KIKOFF $12* CFPFIQLS5H', 96, '-10.30'), row('KIKOFF $12* CFPFIQLS5H', 66, '-10.30'),
          row('KIKOFFINC* CLIJ6K4ACX', 36, '-35.00'), row('KIKOFFINC* CLIJ6K4ACX', 6, '-35.00'),
          ''].join('\n'),
      ),
    });
    await service.refreshRecurringClassifications();

    const recurring = await service.listRecurring();
    if (recurring.status !== 'ok') throw new Error(`expected ok, got ${recurring.status}`);
    const kikoff = recurring.items.filter((item) => item.merchant.toLowerCase() === 'kikoff');
    expect(kikoff).toHaveLength(1); // merged, not two fragments
    expect(kikoff[0]!.count).toBe(4); // all four charges, not "twice"
    expect(kikoff[0]!.kind).toBe('loan');
    expect(kikoff[0]!.transactions).toHaveLength(4);
    // Attached transactions are ordered most-recent first for drill-down.
    expect(kikoff[0]!.transactions[0]!.date >= kikoff[0]!.transactions[3]!.date).toBe(true);
    service.close();
  });

  it('drops a variable-amount charge the model mislabels as a membership (fixed-fee backstop)', async () => {
    // A model that calls everything a recurring membership; the deterministic
    // backstop must still reject the one whose amounts vary like shopping.
    const alwaysMembership: RecurringClassifier = async (candidates) =>
      candidates.map((candidate) => ({
        merchant: candidate.merchant,
        direction: candidate.direction,
        isRecurring: true,
        kind: 'membership',
        cadence: 'monthly',
        canonicalName: candidate.label,
        confidence: 0.9,
      }));
    const service = application(alwaysMembership);
    const account = service.createAccount({ institution: 'Example Bank', name: 'Checking', type: 'checking', currency: 'USD' });
    const row = (desc: string, day: number, amount: string) => `${daysAgo(day)},${desc},${amount}`;
    service.importStatement({
      accountId: account.id,
      filename: 'm.csv',
      content: Buffer.from(
        ['Date,Description,Amount',
          // A real fixed monthly fee — stable amount → survives.
          row('CITY GYM CLUB', 65, '-40.00'), row('CITY GYM CLUB', 35, '-40.00'), row('CITY GYM CLUB', 5, '-40.00'),
          // "Membership" in name only: amounts swing like ordinary shopping → backstop drops it.
          row('CORNER MARKET', 60, '-8.00'), row('CORNER MARKET', 20, '-73.00'),
          ''].join('\n'),
      ),
    });
    await service.refreshRecurringClassifications();
    const recurring = await service.listRecurring();
    if (recurring.status !== 'ok') throw new Error(`expected ok, got ${recurring.status}`);
    const names = recurring.items.map((item) => item.merchant.toUpperCase());
    expect(names.some((n) => n.includes('CITY GYM CLUB'))).toBe(true);
    expect(names.some((n) => n.includes('CORNER MARKET'))).toBe(false);
    service.close();
  });

  it('flags a material month-over-month net-worth drop', () => {
    const repository = new SqliteFinanceRepository(':memory:');
    const service = new FinanceService(repository, [new OfxStatementParser(), new CsvStatementParser()], localModel());
    service.createRule({ text: 'net worth movement', scope: 'all', cadence: 'monthly' });
    const account = service.createAccount({ institution: 'Example Bank', name: 'Checking', type: 'checking', currency: 'USD' });
    repository.saveProviderBalances([
      { accountId: account.id, asOfDate: '2026-06-01', currentMinor: 1_000_000, currency: 'USD', fingerprint: 'b:jun' },
      { accountId: account.id, asOfDate: '2026-07-04', currentMinor: 850_000, currency: 'USD', fingerprint: 'b:jul' },
    ]);
    const finding = service.listFindings().find((f) => f.kind === 'net-worth-movement');
    expect(finding?.title).toContain('Net worth dropped');
    expect(finding?.severity).toBe('medium');
    service.close();
  });

  it('seeds built-in rule specs as data so the engine is table-driven', () => {
    const repository = new SqliteFinanceRepository(':memory:');
    const service = new FinanceService(repository, [new OfxStatementParser(), new CsvStatementParser()], localModel());
    const specs = repository.listRuleSpecs();
    expect(specs.length).toBeGreaterThanOrEqual(20);
    // Every rule is a data spec carrying its own query — no per-rule code.
    expect(specs.every((spec) => Boolean(spec.sql) || Boolean(spec.prompt))).toBe(true);
    expect(specs.find((spec) => spec.kind === 'credit-utilization')?.sql).toContain('utilization is elevated');
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

  it('ignores Equifax inquiry section explanatory text', async () => {
    const service = application();
    const pdf = Buffer.from(`%PDF-1.7
Equifax Credit Report
Report Date: 06/15/2026
Creditor: Chase Bank
Account Number: XXXX1234
Account Type: Credit Card
Status: Pays As Agreed
Balance: $0
Credit Limit: $5,000
Inquiries
Hard + soft
This section shows who accessed your credit report and when. Too many hard inquiries can negatively impact your credit score
Hard inquiry
and any unfamiliar inquiries may be a sign of identity theft.
Hard inquiry
A request for your credit history is called an inquiry. There are two types of inquiries - those that may impact your credit
Hard inquiry
Hard Inquiries that can impact your credit rating/score.
Soft inquiry
you've applied for credit, it results in a hard inquiry which may impact your credit score.
Soft inquiry
Soft Inquiries that do not impact your credit rating/score.
Soft inquiry
These are inquiries, for example, from companies making
Soft inquiry
Type
Soft inquiry
`);

    const result = await service.importCreditReport({ filename: 'equifax-report.pdf', content: pdf });
    expect(result).toMatchObject({
      ok: true,
      status: 'processed',
      report: {
        bureau: 'equifax',
        inquiries: 0,
      },
    });
    expect(service.getCreditOverview().inquiries).toEqual([]);
    service.close();
  });

  it('parses Equifax account and inquiry table layouts', async () => {
    const service = application();
    const pdf = Buffer.from(`%PDF-1.7
Equifax Credit Report
Date: March 21, 2026
Confirmation # 6080581558
Credit Accounts
Bank of America
PO Box 982238, El Paso, TX 79998-2238 | (800) 421-2110
Date Reported:
03/11/2026
| Balance:
$0
Account Number:
*7570
Credit Limit:
$4,500
Loan/Account Type:
Credit Card
| Status:
Pays As Agreed
Date Opened:
06/12/2015
ROBINHOOD/COASTAL COMMUNITY
548 MARKET ST # 30684, SAN FRANCISCO, CA 94104-5401 | (650) 761-7790Date Reported:
02/24/2026
| Balance:
$213
Account Number:
*7515
Credit Limit:
$10,000
Loan/Account Type:
Credit Card
| Status:
Pays As Agreed
Date Opened:
09/25/2025
Company Information
Inquiry Type
Inquiry Date(s)
Factual Data Consumer Assistance
PO Box 530090 Atlanta GA 30353
Phone: (877) 237-8317
Hard
01/21/2026
EQUIFAX CONSUMER SERVICES
1550 PEACHTREE ST NW ATLANTA GA 30309-2468
Phone: (800) 458-9988
Soft
03/01/2026, 06/01/2025
`);

    const result = await service.importCreditReport({ filename: 'creditReport_6080581558.pdf', content: pdf });
    const overview = service.getCreditOverview();
    expect(result.report).toMatchObject({
      bureau: 'equifax',
      accounts: 2,
      openAccounts: 2,
      inquiries: 1,
    });
    expect(overview.accounts.map((account) => ({
      creditor: account.creditor,
      mask: account.accountMask,
      balance: account.balanceMinor,
    }))).toEqual([
      { creditor: 'Bank of America', mask: '*7570', balance: 0 },
      { creditor: 'ROBINHOOD/COASTAL COMMUNITY', mask: '*7515', balance: 21300 },
    ]);
    expect(overview.inquiries).toEqual([
      { company: 'Factual Data Consumer Assistance', inquiryDate: '2026-01-21', type: 'hard' },
      { company: 'EQUIFAX CONSUMER SERVICES', inquiryDate: '2026-03-01', type: 'soft' },
    ]);
    service.close();
  });

  it('filters inquiry noise from previously saved credit reports', () => {
    const repository = new SqliteFinanceRepository(':memory:');
    repository.saveCreditReport({
      filename: 'equifax-report.pdf',
      contentHash: 'old-bad-parse',
      bureau: 'equifax',
      reportDate: '2026-06-15',
      score: null,
      scoreModel: null,
      utilizationPercent: null,
      totalBalanceMinor: null,
      totalLimitMinor: null,
      accounts: 1,
      openAccounts: 1,
      delinquentAccounts: 0,
      collections: 0,
      inquiries: 2,
      publicRecords: 0,
      raw: {
        accounts: [{
          creditor: 'Chase Bank',
          accountMask: '*1234',
          accountType: 'Credit Card',
          status: 'Pays As Agreed',
          isOpen: true,
          isNegative: false,
          isRevolving: true,
          dateOpened: null,
          dateReported: null,
          balanceMinor: 0,
          creditLimitMinor: 500000,
          pastDueMinor: 0,
        }],
        inquiries: [
          { company: 'This section shows who accessed your credit report and when. Too many hard inquiries can negatively impact your credit score', inquiryDate: null, type: 'hard' },
          { company: 'Hard inquiry', inquiryDate: null, type: 'hard' },
          { company: 'and any unfamiliar inquiries may be a sign of identity theft.', inquiryDate: null, type: 'hard' },
          { company: 'Date(s)', inquiryDate: null, type: 'soft' },
          { company: 'You have a right to receive a record of all inquiries relating to a credit transaction initiated in 12 months preceding', inquiryDate: null, type: 'soft' },
          { company: 'Example Auto Finance', inquiryDate: '2026-05-01', type: 'hard' },
        ],
        suggestions: [],
      },
      bytes: 1024,
    });
    const service = new FinanceService(repository, [new OfxStatementParser(), new CsvStatementParser()], localModel());

    const overview = service.getCreditOverview();
    expect(overview.inquiries).toEqual([{ company: 'Example Auto Finance', inquiryDate: '2026-05-01', type: 'hard' }]);
    expect(overview.latest?.inquiries).toBe(1);
    expect(overview.reports[0]?.raw.inquiries).toEqual(overview.inquiries);
    service.close();
  });
});

describe('enrichCreditExtractionWithLlm', () => {
  const acct = (creditor: string, accountMask: string | null) => ({
    creditor, accountMask, accountType: 'Credit card', status: 'Open/Never late.',
    isOpen: true, isNegative: false, isRevolving: true, dateOpened: null, dateReported: null,
    balanceMinor: 0, creditLimitMinor: 1000000, pastDueMinor: null,
  });
  const base = (text: string, accounts: ReturnType<typeof acct>[], inquiries: { company: string; inquiryDate: string | null; type: 'hard' | 'soft' }[]) => ({
    bureau: 'experian', reportDate: null, score: null, scoreModel: null,
    accounts, inquiries, suggestions: [], textSample: text.slice(0, 1200), text,
  });
  const reply = (json: string) => async () => json;
  const meta = { provider: 'anthropic', model: 'claude', now: '2026-07-07T00:00:00Z' };
  // Report text the model must ground against; contains US BANK, DISCOVERC, BANK OF AMERICA,
  // FACTUAL DATA — but NOT "GHOST BANK" or "FAKE INQUIRY CO".
  const text = 'BANK OF AMERICA 440066 Credit card $0\nUS BANK 403784 Credit Card $25,000 Open/Never late.\nHard Inquiries\nFACTUAL DATA Inquired on 01/21/2026\nDISCOVERC Inquired on 09/30/2024';

  it('adds grounded rows the deterministic parse missed and drops hallucinated ones', async () => {
    const extracted = base(text, [acct('BANK OF AMERICA', '*0066')], [{ company: 'FACTUAL DATA', inquiryDate: '2026-01-21', type: 'hard' }]);
    const json = JSON.stringify({
      accounts: [
        { creditor: 'US BANK', accountMask: '*3784', accountType: 'Credit Card', status: 'Open/Never late.', balance: '$0', creditLimit: '$25,000', dateOpened: null },
        { creditor: 'GHOST BANK', accountMask: '*9999', balance: '$500', creditLimit: '$1,000', status: 'Open' },
      ],
      inquiries: [
        { company: 'DISCOVERC', inquiryDate: '09/30/2024', type: 'hard' },
        { company: 'FAKE INQUIRY CO', inquiryDate: '01/01/2020', type: 'hard' },
        { company: 'FACTUAL DATA', inquiryDate: '2026-01-21', type: 'hard' },
      ],
    });
    const { extraction, aiReview } = await enrichCreditExtractionWithLlm(extracted, text, reply(json), meta);
    expect(aiReview).toMatchObject({ addedAccounts: 1, addedInquiries: 1, provider: 'anthropic' });
    expect(extraction.accounts.map((a) => a.creditor)).toEqual(['BANK OF AMERICA', 'US BANK']);
    expect(extraction.accounts[1]?.creditLimitMinor).toBe(2500000);
    expect(extraction.inquiries.map((q) => q.company)).toEqual(['FACTUAL DATA', 'DISCOVERC']);
    expect(extraction.inquiries.find((q) => q.company === 'DISCOVERC')?.inquiryDate).toBe('2024-09-30');
    // Hallucinated entries never present in the text are dropped.
    expect(extraction.accounts.some((a) => a.creditor === 'GHOST BANK')).toBe(false);
    expect(extraction.inquiries.some((q) => q.company === 'FAKE INQUIRY CO')).toBe(false);
  });

  it('leaves the deterministic result untouched when the model call fails', async () => {
    const extracted = base(text, [acct('BANK OF AMERICA', '*0066')], [{ company: 'FACTUAL DATA', inquiryDate: '2026-01-21', type: 'hard' }]);
    const throwing = async () => { throw new Error('model down'); };
    const { extraction, aiReview } = await enrichCreditExtractionWithLlm(extracted, text, throwing, meta);
    expect(aiReview).toBeNull();
    expect(extraction.accounts).toHaveLength(1);
    expect(extraction.inquiries).toHaveLength(1);
  });

  it('salvages an unknown-format report the deterministic parse left empty', async () => {
    const extracted = base(text, [], []);
    const json = JSON.stringify({ accounts: [], inquiries: [{ company: 'DISCOVERC', inquiryDate: '09/30/2024', type: 'hard' }] });
    const { extraction, aiReview } = await enrichCreditExtractionWithLlm(extracted, text, reply(json), meta);
    expect(aiReview).toMatchObject({ addedInquiries: 1 });
    expect(extraction.inquiries).toEqual([{ company: 'DISCOVERC', inquiryDate: '2024-09-30', type: 'hard' }]);
  });

  it('returns null review when the model adds nothing new', async () => {
    const extracted = base(text, [acct('BANK OF AMERICA', '*0066')], [{ company: 'FACTUAL DATA', inquiryDate: '2026-01-21', type: 'hard' }]);
    const json = JSON.stringify({ accounts: [], inquiries: [{ company: 'FACTUAL DATA', inquiryDate: '2026-01-21', type: 'hard' }] });
    const { aiReview } = await enrichCreditExtractionWithLlm(extracted, text, reply(json), meta);
    expect(aiReview).toBeNull();
  });
});
