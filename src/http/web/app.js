import vegaEmbed from 'vega-embed';

const $ = (selector) => document.querySelector(selector);
const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}[char]));

const markdownToken = (index) => `\u0000MD${index}\u0000`;

function safeMarkdownUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    if (['http:', 'https:', 'mailto:'].includes(url.protocol)) return url.href;
  } catch {
    return null;
  }
  return null;
}

function renderMarkdownInline(value) {
  const tokens = [];
  let text = String(value ?? '').replace(/`([^`\n]+)`/g, (_, code) => {
    const token = markdownToken(tokens.length);
    tokens.push(`<code>${esc(code)}</code>`);
    return token;
  });
  text = esc(text);
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const safeHref = safeMarkdownUrl(href);
    if (!safeHref) return match;
    return `<a href="${esc(safeHref)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  text = text
    .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
    .replace(/(\*|_)([^*_]+?)\1/g, '<em>$2</em>');
  tokens.forEach((html, index) => {
    text = text.replaceAll(markdownToken(index), html);
  });
  return text;
}

function isMarkdownBlockStart(line) {
  return /^```/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^>\s?/.test(line)
    || /^(\s*[-*+]\s+|\s*\d+\.\s+)/.test(line)
    || /\|/.test(line);
}

function splitMarkdownCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderMarkdownTable(lines, start) {
  const header = splitMarkdownCells(lines[start]);
  const rows = [];
  let index = start + 2;
  while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) {
    rows.push(splitMarkdownCells(lines[index]));
    index += 1;
  }
  const head = header.map((cell) => `<th>${renderMarkdownInline(cell)}</th>`).join('');
  const body = rows.map((row) => `<tr>${header.map((_, column) => `<td>${renderMarkdownInline(row[column] || '')}</td>`).join('')}</tr>`).join('');
  return { html: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`, index };
}

function renderMarkdown(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^```\s*([\w-]+)?\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const lang = fence[1] ? ` class="language-${esc(fence[1])}"` : '';
      html.push(`<pre><code${lang}>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (index + 1 < lines.length && /\|/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
      const table = renderMarkdownTable(lines, index);
      html.push(table.html);
      index = table.index;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }
    const list = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (list) {
      const ordered = /\d+\./.test(list[2]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[2]) !== ordered) break;
        items.push(`<li>${renderMarkdownInline(item[3])}</li>`);
        index += 1;
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${paragraph.map(renderMarkdownInline).join('<br>')}</p>`);
  }
  return html.join('');
}

const desktopToken = new URLSearchParams(window.location.search).get('session');
const today = new Date();
const before = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90);
const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const state = {
  section: 'feed',
  bankTab: 'summary',
  brokerageTab: 'summary',
  accountId: null,
  // Whether the user has explicitly picked an account card yet. Until they do,
  // 'All accounts' is not shown as selected (the overview still renders).
  accountTouched: false,
  from: isoDate(before),
  to: isoDate(today),
  accounts: [],
  summary: [],
  transactions: [],
  recurring: null,
  recurringLoading: false,
  nextCursor: null,
  connections: [],
  brokerageSummary: [],
  brokerageTransactions: [],
  brokerageHoldings: [],
  brokerageValueSeries: [],
  brokerageValueSeriesByScope: {},
  brokerageValueLoading: new Set(),
  balances: [],
  dashboards: [],
  settings: [],
  llm: null,
  rules: [],
  factNeeds: { byKind: {}, pending: [] },
  insights: [],
  insightMutes: [],
  credit: { reports: [], accounts: [], inquiries: [], suggestions: [], latest: null },
  creditTab: 'latest',
  settingsTab: 'models',
  notificationChannel: 'telegram',
  threads: [],
  thread: null,
  contextAttachments: [],
  tablePages: {},
  tableSearch: {},
  tablePageSizes: {},
};

const sections = [
  { id: 'feed', label: 'Insights' },
  { id: 'banks', label: 'Banking' },
  { id: 'brokerage', label: 'Brokerage' },
  { id: 'credit', label: 'Credit' },
  { id: 'dashboards', label: 'Dashboards' },
  { id: 'settings', label: 'Settings' },
];
const defaultPageSize = 10;
const pageSizeOptions = [10, 25, 50, 100];
const bankTabs = [['summary', 'Summary'], ['transactions', 'Transactions'], ['cashflow', 'Cash flow'], ['recurring', 'Recurring']];
const brokerageTabs = [['summary', 'Summary'], ['transactions', 'Transactions']];
const settingsTabs = [['models', 'Models'], ['accounts', 'Bank/Brokerage'], ['delivery', 'Delivery'], ['insights', 'Rules & Facts']];
const creditTabs = [['latest', 'Latest report overview'], ['reports', 'Reports']];
// [name, cadence, scope, executionClass, scheduledHour, detail, domain]. The
// domain follows the rules taxonomy in docs/rules-design.md and drives the
// grouped Rules UI. Rows backed by a live evaluator carry their real D class;
// aspirational rows keep their intended L / L+ class until wired.
// Display labels for the backend rules, keyed by kind (the backend is the single
// source of truth for which rules exist and their on/off state; this only makes
// their names/descriptions read nicely). A kind with no entry falls back to a
// prettified version of its slug, so new rules show up without edits here.
const RULE_META = {
  'connection-health': { title: 'Connection health', detail: 'Flag when a connection is not active, a token is missing, or the sync cursor is missing.' },
  'stale-data': { title: 'Stale account data', detail: 'Flag when the newest balance or transaction is weeks old.' },
  'idle-cash': { title: 'Idle cash', detail: 'Price checking/savings cash against a high-yield benchmark and surface the yield left on the table.' },
  'low-balance': { title: 'Low / negative balance', detail: 'Flag a spending balance that falls below a safety threshold or goes overdrawn.' },
  'cash-runway': { title: 'Cash runway', detail: 'Estimate months of runway from liquid cash and average spending, and flag when it is short.' },
  'net-worth-movement': { title: 'Net worth movement', detail: 'Flag a material month-over-month drop in net worth.' },
  'cash-flow-negative': { title: 'Cash flow negative', detail: 'Flag when 30-day spending outran income and drew down savings.' },
  'upcoming-bills': { title: 'Upcoming bills / overdraft', detail: 'Warn when recurring bills due before the next deposit exceed available cash.' },
  'employer-match': { title: 'Employer 401(k) match', detail: 'Flag forgone employer match — free money left on the table. Needs your salary and match details.' },
  'large-transaction': { title: 'Large transaction', detail: 'Notify when a posted outflow exceeds $500.' },
  'duplicate-charge': { title: 'Duplicate charge', detail: 'Flag two matching merchant charges of the same amount within a few days.' },
  'cross-account-duplicate': { title: 'Duplicate payment across accounts', detail: 'Flag the same vendor and amount paid from two different accounts.' },
  'card-testing': { title: 'Card testing / probe', detail: 'Flag a tiny charge at a brand-new merchant followed by larger charges — a card-testing pattern.' },
  'fees-and-interest': { title: 'Fees & interest', detail: 'Total the bank fees, card interest, and surcharges paid over the last 90 days.' },
  'subscription-price-increase': { title: 'Subscription price increase', detail: 'Flag a recurring charge whose latest amount rose against its own history.' },
  'recurring-subscriptions': { title: 'Recurring subscriptions', detail: 'List detected subscriptions and their annualized cost so ghost memberships are visible.' },
  'new-recurring-charge': { title: 'New recurring charge', detail: 'Flag a recently started subscription or a free trial that converted to paid.' },
  'spending-category-spike': { title: 'Spending category spike', detail: 'Flag a discretionary category whose last-30-day spend is well above its 3-month average.' },
  'cross-card-subscription': { title: 'Duplicate subscription across cards', detail: 'Flag the same subscription billed on more than one account — paying twice.' },
  'unfamiliar-merchant-charge': { title: 'Unfamiliar merchant charge', detail: 'Flag a large charge at a merchant with no prior history.' },
  'credit-utilization': { title: 'Credit utilization', detail: 'Notify when a card balance exceeds 30% or 70% of its known limit.' },
  'card-interest': { title: 'Card interest', detail: 'Flag interest charged on a card — the cost of carrying a balance.' },
  'idle-brokerage-cash': { title: 'Brokerage cash drag', detail: 'Flag brokerage cash above 30% of portfolio value.' },
  'portfolio-concentration': { title: 'Portfolio concentration', detail: 'Flag any single holding above 20% of tracked holdings value.' },
  'single-name-exposure': { title: 'Single-name exposure', detail: 'Flag one position that is an outsized share of total net worth.' },
  'holding-swing': { title: 'Holding value swing', detail: 'Flag a holding whose value moved sharply since the prior snapshot.' },
  'wash-sale-risk': { title: 'Wash sale review', detail: 'Flag a symbol sold and repurchased within 30 days to review before filing.' },
  'executed-trades': { title: 'Executed trades', detail: 'Notify on recent executed buy and sell orders.' },
  'dividends-received': { title: 'Dividends & interest', detail: 'Total dividends and interest received over the last 90 days for tax time.' },
};

function prettyKind(kind) {
  return String(kind || '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
// The rules taxonomy from docs/rules-design.md, in display order. Used to group
// both built-in and saved rules in the settings UI.
const ruleDomains = [
  ['cash-flow', 'Cash flow', 'Income timing, bill runway, idle cash, low balance.'],
  ['spending', 'Spending', 'Large charges, duplicates, subscriptions, fees.'],
  ['credit-report', 'Credit report', 'Credit-report health: utilization, card interest.'],
  ['investments', 'Investments', 'Cash drag, concentration, allocation, executed orders.'],
  ['connections', 'Connections', 'Provider status, tokens, cursors, sync freshness.'],
];
const notificationChannels = {
  telegram: {
    title: 'Telegram',
    summary: 'Best for direct, low-volume personal insights.',
    statusKeys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    rows: [['TELEGRAM_BOT_TOKEN', 'Bot token', 'password']],
    steps: [
      ['Create bot', 'Use BotFather to create a bot and copy the bot token.'],
      ['Save token', 'Paste only the bot token here.'],
      ['Connect chat', 'Send any message to the bot in Telegram, then click Connect chat below.'],
    ],
    note: 'Telegram uses the latest message sent to your bot to bind the delivery chat. Finora does not ask you to paste a chat id.',
  },
  slack: {
    title: 'Slack',
    summary: 'Best for shared household, advisor, or operations channels.',
    statusKeys: ['SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID'],
    rows: [['SLACK_BOT_TOKEN', 'Bot token', 'password'], ['SLACK_CHANNEL_ID', 'Channel ID', 'text']],
    steps: [
      ['Create app', 'Create a Slack app with chat:write and channels:read, then install it to the workspace.'],
      ['Invite bot', 'Invite the bot to the target channel. A future channel picker should replace manual channel ID entry.'],
      ['Save target', 'Save the bot token and selected channel so insights have one clear delivery destination.'],
    ],
    note: 'Slack still needs a target channel. Keep this as one channel-level credential block until a channel picker is available.',
  },
};
let activeCreditUpload = null;
const pendingChatContent = '__FINORA_THINKING__';

// Auto-update is only meaningful inside the packaged desktop app, where Tauri
// injects its IPC bridge. In a plain browser (web mode) window.__TAURI_INTERNALS__
// is undefined, so the update banner and its dynamic imports never activate.
const isDesktopApp = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
// status: 'idle' | 'available' | 'downloading' | 'installing' | 'error'
let updateState = { status: 'idle', version: null, currentVersion: null, progress: 0, error: null };
let pendingUpdate = null;

async function checkForUpdate() {
  if (!isDesktopApp) return;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) {
      pendingUpdate = update;
      updateState = {
        status: 'available',
        version: update.version,
        currentVersion: update.currentVersion,
        progress: 0,
        error: null,
      };
    } else {
      updateState = { status: 'idle', version: null, currentVersion: null, progress: 0, error: null };
    }
  } catch (error) {
    // A missing/unreachable latest.json is normal (e.g. no release yet); keep it
    // quiet rather than nagging the user with a failure they can't act on.
    updateState = { status: 'idle', version: null, currentVersion: null, progress: 0, error: null };
    console.warn('Update check failed:', error);
  }
  renderSidebar();
}

async function runUpdate() {
  if (!pendingUpdate || updateState.status === 'downloading' || updateState.status === 'installing') return;
  try {
    updateState = { ...updateState, status: 'downloading', progress: 0, error: null };
    renderSidebar();
    let downloaded = 0;
    let total = 0;
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data?.contentLength || 0;
      } else if (event.event === 'Progress') {
        downloaded += event.data?.chunkLength || 0;
        updateState.progress = total ? Math.min(1, downloaded / total) : 0;
        renderSidebar();
      } else if (event.event === 'Finished') {
        updateState.progress = 1;
      }
    });
    updateState = { ...updateState, status: 'installing', progress: 1 };
    renderSidebar();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (error) {
    updateState = { ...updateState, status: 'error', error: error?.message || String(error) };
    renderSidebar();
  }
}

function renderUpdateBanner() {
  if (!isDesktopApp || updateState.status === 'idle') return null;
  const wrap = el('div', 'updatebanner');

  if (updateState.status === 'error') {
    wrap.classList.add('is-error');
    const title = el('div', 'updatetitle');
    title.textContent = 'Update failed';
    const detail = el('div', 'updatesub');
    detail.textContent = updateState.error || 'Could not install the update.';
    const retry = el('button', 'updatebtn');
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.addEventListener('click', runUpdate);
    wrap.append(title, detail, retry);
    return wrap;
  }

  const title = el('div', 'updatetitle');
  title.textContent = 'Update available';
  const sub = el('div', 'updatesub');
  sub.textContent = updateState.currentVersion
    ? `v${updateState.currentVersion} → v${updateState.version}`
    : `Version ${updateState.version}`;
  wrap.append(title, sub);

  if (updateState.status === 'downloading') {
    const bar = el('div', 'updateprogress');
    const fill = el('div', 'updateprogressfill');
    fill.style.width = `${Math.round(updateState.progress * 100)}%`;
    bar.appendChild(fill);
    const label = el('div', 'updatesub');
    label.textContent = `Downloading… ${Math.round(updateState.progress * 100)}%`;
    wrap.append(bar, label);
  } else if (updateState.status === 'installing') {
    const label = el('div', 'updatesub');
    label.textContent = 'Installing… the app will restart.';
    wrap.append(label);
  } else {
    const btn = el('button', 'updatebtn');
    btn.type = 'button';
    btn.textContent = 'Update now';
    btn.addEventListener('click', runUpdate);
    wrap.append(btn);
  }

  return wrap;
}

async function api(path, options) {
  const request = { ...(options ?? {}) };
  request.headers = new Headers(request.headers);
  if (desktopToken) request.headers.set('X-Finora-Desktop-Token', desktopToken);
  const url = new URL(path, location.origin);
  const response = await fetch(url, request);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ? `${body.error.message} (${url.pathname})` : `Request failed (${response.status})`);
  return body;
}

function money(amount, currency = 'USD') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount || 0) / 100);
}

const chartPalette = ['#2563eb', '#047857', '#b45309', '#7c3aed', '#0891b2', '#dc2626', '#64748b', '#10b981'];

function chartColor(value, index = 0) {
  if (value === null || value === undefined || value === '') return chartPalette[index % chartPalette.length];
  let hash = 0;
  for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return chartPalette[hash % chartPalette.length];
}

function chartLabel(value) {
  return String(value || 'Value').replace(/_cents$/i, '').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeArtifact(saved) {
  const artifact = saved?.artifact && typeof saved.artifact === 'object' ? saved.artifact : {};
  return {
    ...artifact,
    title: artifact.title || saved?.name || 'Chart',
    render: artifact.render && typeof artifact.render === 'object' ? artifact.render : { type: 'table' },
    style: artifact.style && typeof artifact.style === 'object' ? artifact.style : {},
  };
}

function monthKey(date) {
  return String(date || '').slice(0, 7) || 'Unknown';
}

function weekKey(date) {
  const parsed = new Date(`${String(date || '').slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  const day = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() - day + 1);
  return parsed.toISOString().slice(0, 10);
}

function periodKey(date, granularity = 'month') {
  return granularity === 'week' ? weekKey(date) : monthKey(date);
}

function groupSum(rows, keyFn, valueFn, seedFn = (key) => ({ key })) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const current = map.get(key) || seedFn(key, row);
    valueFn(current, row);
    map.set(key, current);
  }
  return [...map.values()];
}

function chartRowsFromInline(artifact) {
  const data = artifact.data || artifact.values || artifact.rows || artifact.dataset;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.values)) return data.values;
  return null;
}

function resolveArtifactRows(artifact) {
  const inline = chartRowsFromInline(artifact);
  if (inline) return inline;
  const source = artifact.dataSource || {};
  const name = String(source.name || source.kind || '').toLowerCase();
  const params = source.params || {};
  const scopedTransactions = (rows = state.transactions) => rows.filter((txn) => {
    if (params.from && txn.date < params.from) return false;
    if (params.to && txn.date > params.to) return false;
    const acct = account(txn.accountId);
    if (params.accountType === 'credit' && !isCreditAccount(acct || {})) return false;
    if (params.accountType === 'banking' && isCreditAccount(acct || {})) return false;
    return true;
  });

  if (name.includes('cash_flow')) {
    const txns = scopedTransactions();
    const rows = groupSum(
      txns,
      (txn) => `${periodKey(txn.date, params.granularity)}${params.groupBy === 'account' ? `|${accountLabel(txn.accountId)}` : ''}`,
      (row, txn) => {
        if (txn.amountMinor >= 0) row.income_cents += txn.amountMinor;
        else row.expense_cents += Math.abs(txn.amountMinor);
        row.net_cents += txn.amountMinor;
      },
      (key) => {
        const [period, accountName] = key.split('|');
        return { period, account: accountName, income_cents: 0, expense_cents: 0, net_cents: 0 };
      },
    );
    return rows.sort((a, b) => `${a.period}${a.account || ''}`.localeCompare(`${b.period}${b.account || ''}`));
  }

  if (name.includes('transaction_count')) {
    return groupSum(
      scopedTransactions(),
      (txn) => `${periodKey(txn.date, params.granularity)}${params.groupBy === 'account' ? `|${accountLabel(txn.accountId)}` : ''}`,
      (row, txn) => {
        row.transactions += 1;
        if (txn.amountMinor < 0) row.outflows += 1;
        if (txn.amountMinor >= 0) row.inflows += 1;
      },
      (key) => {
        const [period, accountName] = key.split('|');
        return { period, account: accountName, transactions: 0, outflows: 0, inflows: 0 };
      },
    ).sort((a, b) => `${a.period}${a.account || ''}`.localeCompare(`${b.period}${b.account || ''}`));
  }

  if (name.includes('spending') || name.includes('category')) {
    return groupSum(
      scopedTransactions().filter(isSpendingTransaction),
      (txn) => txn.category || 'Uncategorized',
      (row, txn) => {
        row.amount_cents += Math.abs(txn.amountMinor);
        row.transactions += 1;
      },
      (category) => ({ category, amount_cents: 0, transactions: 0 }),
    ).sort((a, b) => b.amount_cents - a.amount_cents);
  }

  if (name.includes('merchant')) {
    return groupSum(
      scopedTransactions().filter(isSpendingTransaction),
      (txn) => txn.description || 'Unknown',
      (row, txn) => {
        row.amount_cents += Math.abs(txn.amountMinor);
        row.transactions += 1;
      },
      (merchant) => ({ merchant, amount_cents: 0, transactions: 0 }),
    ).sort((a, b) => b.amount_cents - a.amount_cents).slice(0, 12);
  }

  if (name.includes('holding') || name.includes('portfolio')) {
    return state.brokerageHoldings.map((holding) => ({
      symbol: holding.symbol || holding.name || 'Holding',
      name: holding.name || holding.symbol || 'Holding',
      value_cents: holding.valueMinor,
      quantity: holding.quantity,
      account: accountLabel(holding.accountId),
    })).sort((a, b) => Number(b.value_cents || 0) - Number(a.value_cents || 0));
  }

  if (name.includes('balance') || name.includes('account')) {
    return state.accounts.map((acct) => {
      const balance = state.balances.filter((item) => item.accountId === acct.id).sort((a, b) => b.asOfDate.localeCompare(a.asOfDate))[0];
      const summary = state.summary.find((item) => item.currency === acct.currency);
      return {
        account: `${acct.institution} / ${acct.name}`,
        balance_cents: balance?.currentMinor ?? summary?.netMinor ?? 0,
        cash_cents: balance?.cashMinor ?? null,
        transactions: state.transactions.filter((txn) => txn.accountId === acct.id).length,
      };
    });
  }

  return [];
}

function chartSeries(artifact, rows) {
  const y = artifact.render?.y;
  const fields = Array.isArray(y) ? y : y ? [y] : [];
  const inferred = fields.length ? fields : Object.keys(rows[0] || {}).filter((key) => typeof rows[0][key] === 'number').slice(0, 3);
  const defs = artifact.render?.options?.series || [];
  return inferred.map((field, index) => ({
    field,
    label: defs[index]?.label || chartLabel(field),
    color: chartColor(field, index),
  }));
}

function formatChartValue(value, format, field) {
  if (value === null || value === undefined || value === '') return '-';
  if (format === 'currency' || /_cents$/i.test(String(field || ''))) return money(value);
  if (format === 'percent') return `${Number(value || 0).toFixed(1)}%`;
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : String(value);
}

function renderArtifactTable(host, rows) {
  if (!rows.length) {
    host.appendChild(empty('No data for this chart.'));
    return;
  }
  const keys = Object.keys(rows[0]).slice(0, 6);
  host.appendChild(transactionLikeTable(keys.map(chartLabel), rows.slice(0, 20).map((row) => keys.map((key) => esc(formatChartValue(row[key], null, key))))));
}

function vegaRows(rows, series, format) {
  const cents = format === 'currency' || series.some((item) => /_cents$/i.test(item.field));
  return rows.map((row) => {
    const next = { ...row };
    for (const item of series) {
      const raw = row[item.field];
      // Preserve null/undefined as null so Vega treats it as invalid (a gap in a
      // line/area, e.g. axis-anchor points) rather than a real 0.
      next[`__${item.field}`] = raw === null || raw === undefined
        ? null
        : (cents ? Number(raw) / 100 : Number(raw));
    }
    return next;
  });
}

function vegaFormat(format) {
  return format === 'currency' ? '$,.2f' : format === 'percent' ? '.1f' : ',.0f';
}

function vegaType(field) {
  const value = String(field || '');
  if (/date/i.test(value)) return 'temporal';
  if (/period|month|week/i.test(value)) return 'ordinal';
  if (/amount|cents|value|cash|income|expense|net|pnl|count|transactions|quantity|price|percent|pct/i.test(value)) return 'quantitative';
  return 'nominal';
}

function buildVegaSpec(artifact, rows, x, series, format) {
  const type = artifact.render?.type || 'bar';
  if (!x || !series.length || !['bar', 'stacked_bar', 'line', 'area', 'donut', 'heatmap', 'combo'].includes(type)) return null;
  const values = vegaRows(rows, series, format);
  const valueField = `__${series[0].field}`;
  const base = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    data: { values },
    width: 'container',
    height: type === 'donut' ? 230 : 240,
    autosize: { type: 'fit', contains: 'padding' },
    config: {
      view: { stroke: null },
      axis: { labelColor: '#6b6256', titleColor: '#6b6256', gridColor: '#e5e0d4', tickColor: '#e5e0d4', domainColor: '#e5e0d4' },
      legend: { orient: 'bottom', labelColor: '#26221d', titleColor: '#6b6256', symbolType: 'circle' },
      bar: { cornerRadiusTopLeft: 4, cornerRadiusTopRight: 4 },
      line: { strokeWidth: 2.5 },
      area: { opacity: 0.18 },
      arc: { stroke: '#fefdfa', strokeWidth: 2 },
    },
  };
  const xEncoding = (extra = {}) => ({
    field: x, type: vegaType(x), title: chartLabel(x),
    axis: {
      labelAngle: -25,
      labelOverlap: true,
      // Optional coarser tick granularity (day/week/month/year) so temporal axes
      // don't fall back to sub-day ("12 PM") ticks on short ranges.
      ...(artifact.render?.xTickInterval ? { tickCount: { interval: artifact.render.xTickInterval, step: 1 } } : {}),
      ...(artifact.render?.xLabelFormat ? { format: artifact.render.xLabelFormat, formatType: 'time' } : {}),
    },
    ...extra,
  });
  const tooltip = [{ field: x, type: vegaType(x), title: chartLabel(x) }];
  if (type === 'donut') {
    return {
      ...base,
      mark: { type: 'arc', innerRadius: 58, outerRadius: 104 },
      encoding: {
        theta: { field: valueField, type: 'quantitative', stack: true },
        color: { field: x, type: 'nominal', title: chartLabel(x), scale: { range: chartPalette } },
        tooltip: [...tooltip, { field: valueField, type: 'quantitative', title: series[0].label, format: vegaFormat(format) }],
      },
    };
  }
  if (series.length > 1) {
    const fields = series.map((item) => `__${item.field}`);
    const labelExpr = series.map((item) => `datum.__series===${JSON.stringify(`__${item.field}`)}?${JSON.stringify(item.label)}`).join(':');
    return {
      ...base,
      transform: [{ fold: fields, as: ['__series', '__value'] }, { calculate: `${labelExpr}:datum.__series`, as: '__series_label' }],
      mark: type === 'line' ? { type: 'line', point: { filled: true, size: 50 } } : type === 'area' ? { type: 'area', line: true, point: { filled: true, size: 42 } } : { type: 'bar' },
      encoding: {
        x: xEncoding(),
        y: { field: '__value', type: 'quantitative', title: 'Value', axis: { format: vegaFormat(format) } },
        color: { field: '__series_label', type: 'nominal', title: null, scale: { domain: series.map((item) => item.label), range: series.map((item) => item.color) } },
        tooltip: [...tooltip, { field: '__series_label', type: 'nominal', title: 'Series' }, { field: '__value', type: 'quantitative', title: 'Value', format: vegaFormat(format) }],
      },
    };
  }
  return {
    ...base,
    mark: type === 'line' ? { type: 'line', point: { filled: true, size: 50 } } : type === 'area' ? { type: 'area', line: true, point: { filled: true, size: 42 } } : { type: 'bar' },
    encoding: {
      x: xEncoding(),
      y: { field: valueField, type: 'quantitative', title: series[0].label, axis: { format: vegaFormat(format) }, stack: type === 'stacked_bar' ? 'zero' : null },
      color: artifact.render?.colorBy ? { field: artifact.render.colorBy, type: 'nominal', title: chartLabel(artifact.render.colorBy), scale: { range: chartPalette } } : { value: series[0].color },
      tooltip: [...tooltip, artifact.render?.colorBy ? { field: artifact.render.colorBy, type: 'nominal', title: chartLabel(artifact.render.colorBy) } : null, { field: valueField, type: 'quantitative', title: series[0].label, format: vegaFormat(format) }].filter(Boolean),
    },
  };
}

function renderVegaChart(chart, artifact, rows, x, series, format) {
  const spec = buildVegaSpec(artifact, rows, x, series, format);
  if (!spec) return false;
  chart.classList.add('vlchart');
  // Vega's default expression compiler uses Function(), which is correctly
  // blocked by Finora's CSP. AST mode uses vega-interpreter instead, preserving
  // interactive charts without weakening script-src with unsafe-eval.
  vegaEmbed(chart, spec, { actions: false, renderer: 'svg', theme: 'none', ast: true, tooltip: true }).catch((error) => {
    chart.classList.remove('vlchart');
    chart.replaceChildren(empty(`Could not render interactive chart: ${error.message || error}`));
  });
  return true;
}

function renderArtifactChart(host, saved, options = {}) {
  const artifact = normalizeArtifact(saved);
  const rows = resolveArtifactRows(artifact);
  const render = artifact.render || {};
  const format = artifact.style?.numberFormat || render.options?.yFormat || 'number';
  const x = render.x || ['period', 'month', 'category', 'merchant', 'symbol', 'account', 'name'].find((key) => rows.some((row) => row[key] !== undefined)) || Object.keys(rows[0] || {})[0];
  const series = chartSeries(artifact, rows);
  const wrap = el('div', `artifact ${artifact.style?.theme === 'dark' ? 'dark' : ''}`);
  wrap.innerHTML = `<div class="ahdr"><div><div class="atitle">${esc(artifact.title)}</div>${artifact.description ? `<div class="adesc">${esc(artifact.description)}</div>` : ''}</div></div>`;
  if (options.contextAction !== false) {
    const chartAction = chatContextButton('Chat', 'Add this chart to chat context');
    setContextButtonState(chartAction, `chart:${saved.publicId || saved.id || artifact.title || 'chart'}`);
    chartAction.addEventListener('click', () => addChartContext(saved, rows, artifact));
    wrap.querySelector('.ahdr').appendChild(chartAction);
  }
  const chart = el('div', 'achart');
  wrap.appendChild(chart);
  host.replaceChildren(wrap);

  if (!rows.length || !series.length) {
    chart.appendChild(empty('No data for this chart.'));
    return;
  }

  if (render.type === 'metric') {
    const cards = el('div', 'cards');
    for (const key of Object.keys(rows[0]).filter((item) => typeof rows[0][item] !== 'object').slice(0, 4)) {
      const card = el('div', 'card');
      card.innerHTML = `<div class="lab">${esc(chartLabel(key))}</div><div class="big num">${esc(formatChartValue(rows[0][key], format, key))}</div>`;
      cards.appendChild(card);
    }
    chart.appendChild(cards);
    return;
  }

  if (render.type === 'table') {
    renderArtifactTable(chart, rows);
    return;
  }

  if (renderVegaChart(chart, artifact, rows, x, series, format)) return;

  if (render.type === 'donut') {
    const field = series[0].field;
    const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row[field] || 0)), 0) || 1;
    let start = 0;
    const stops = rows.slice(0, 10).map((row, index) => {
      const value = Math.max(0, Number(row[field] || 0));
      const end = start + (value / total) * 360;
      const stop = `${chartColor(row[x], index)} ${start}deg ${end}deg`;
      start = end;
      return stop;
    });
    const box = el('div', 'adonuts');
    const donut = el('div', 'adonut');
    donut.style.background = `conic-gradient(${stops.join(', ')})`;
    box.appendChild(donut);
    const legend = el('div', 'legend');
    for (const [index, row] of rows.slice(0, 10).entries()) {
      const item = el('div', 'legrow');
      const value = Math.max(0, Number(row[field] || 0));
      item.innerHTML = `<span class="legdot" style="background:${chartColor(row[x], index)}"></span><span>${esc(row[x] || 'Other')}</span><span class="pct">${Math.round((value / total) * 100)}%</span><span class="amt">${esc(formatChartValue(value, format, field))}</span>`;
      legend.appendChild(item);
    }
    box.appendChild(legend);
    chart.appendChild(box);
    return;
  }

  if (render.type === 'line' || render.type === 'area') {
    const field = series[0].field;
    const values = rows.map((row) => Number(row[field] || 0));
    const max = Math.max(1, ...values.map(Math.abs));
    const width = Math.max(420, rows.length * 56);
    const height = 210;
    const pad = 28;
    const points = rows.map((row, index) => {
      const px = pad + (rows.length === 1 ? 0 : index * (width - pad * 2) / (rows.length - 1));
      const py = height - pad - (Math.max(0, Number(row[field] || 0)) / max) * (height - pad * 2);
      return { px, py, row };
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'aline');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.px},${point.py}`).join(' ');
    svg.innerHTML = `<line class="axis" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"></line><line class="axis" x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}"></line>`;
    if (render.type === 'area' && points.length) {
      const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      fill.setAttribute('d', `${path} L ${points[points.length - 1].px},${height - pad} L ${points[0].px},${height - pad} Z`);
      fill.setAttribute('fill', series[0].color);
      fill.setAttribute('opacity', '0.14');
      svg.appendChild(fill);
    }
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', path);
    line.setAttribute('stroke', series[0].color);
    svg.appendChild(line);
    for (const point of points) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', point.px);
      circle.setAttribute('cy', point.py);
      circle.setAttribute('r', '4');
      circle.setAttribute('stroke', series[0].color);
      circle.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'title')).textContent = `${point.row[x] || ''}: ${formatChartValue(point.row[field], format, field)}`;
      svg.appendChild(circle);
    }
    chart.appendChild(svg);
    return;
  }

  const stacked = render.type === 'stacked_bar' || render.mode === 'stacked';
  const max = Math.max(1, ...rows.map((row) => stacked
    ? series.reduce((sum, item) => sum + Math.abs(Number(row[item.field] || 0)), 0)
    : Math.max(...series.map((item) => Math.abs(Number(row[item.field] || 0))))));
  const grid = el('div', 'abargrid');
  for (const row of rows.slice(0, 18)) {
    const col = el('div', 'abarcol');
    const tip = el('div', 'atip');
    tip.innerHTML = `<b>${esc(row[x] || '')}</b><br>${series.map((item) => `${esc(item.label)} ${esc(formatChartValue(row[item.field], format, item.field))}`).join('<br>')}`;
    col.appendChild(tip);
    const bars = el('div', `abars${stacked ? ' stacked' : ''}`);
    for (const [index, item] of series.entries()) {
      const raw = Number(row[item.field] || 0);
      const bar = el('div', `abar s${index}`);
      bar.style.height = `${Math.max(2, Math.round((Math.abs(raw) / max) * 128))}px`;
      bar.style.background = raw < 0 ? 'var(--red)' : (render.colorBy ? chartColor(row[render.colorBy], index) : item.color);
      bars.appendChild(bar);
    }
    col.appendChild(bars);
    const value = el('div', 'aval');
    value.textContent = series.length === 1 ? formatChartValue(row[series[0].field], format, series[0].field) : '';
    col.appendChild(value);
    const label = el('div', 'alab');
    label.textContent = String(row[x] || '').slice(0, 12);
    col.appendChild(label);
    grid.appendChild(col);
  }
  chart.appendChild(grid);
}

function defaultDashboardArtifacts() {
  return [
    {
      id: 'local.cash_flow',
      publicId: 'local.cash_flow',
      name: 'Monthly cash flow',
      version: 1,
      updatedAt: isoDate(today),
      artifact: {
        title: 'Monthly cash flow',
        description: 'Income, spending, and net cash movement from local transactions.',
        dataSource: { kind: 'tool', name: 'cash_flow', params: { from: state.from, to: state.to, granularity: 'month' } },
        render: { type: 'bar', x: 'period', y: ['income_cents', 'expense_cents', 'net_cents'], options: { yFormat: 'currency' } },
        style: { numberFormat: 'currency' },
      },
    },
    {
      id: 'local.spending_category',
      publicId: 'local.spending_category',
      name: 'Spending by category',
      version: 1,
      updatedAt: isoDate(today),
      artifact: {
        title: 'Spending by category',
        description: 'Largest outflow categories in the selected local ledger.',
        dataSource: { kind: 'tool', name: 'spending_by_category', params: { from: state.from, to: state.to } },
        render: { type: 'donut', x: 'category', y: 'amount_cents', options: { yFormat: 'currency' } },
        style: { numberFormat: 'currency' },
      },
    },
  ];
}

function customDashboardArtifacts() {
  try {
    const rows = JSON.parse(localStorage.getItem(customChartsKey) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function saveCustomDashboardArtifact(artifact) {
  const rows = customDashboardArtifacts();
  rows.unshift(artifact);
  localStorage.setItem(customChartsKey, JSON.stringify(rows.slice(0, 24)));
}

function updateCustomDashboardArtifact(id, artifact) {
  const rows = customDashboardArtifacts();
  const index = rows.findIndex((row) => row.id === id || row.publicId === id);
  if (index === -1) {
    rows.unshift(artifact);
  } else {
    rows[index] = artifact;
  }
  localStorage.setItem(customChartsKey, JSON.stringify(rows.slice(0, 24)));
}

function removeCustomDashboardArtifact(id) {
  localStorage.setItem(customChartsKey, JSON.stringify(customDashboardArtifacts().filter((row) => row.id !== id && row.publicId !== id)));
}

function hiddenDashboardArtifacts() {
  try {
    const rows = JSON.parse(localStorage.getItem(hiddenDashboardArtifactsKey) || '[]');
    return new Set(Array.isArray(rows) ? rows : []);
  } catch {
    return new Set();
  }
}

function hideDashboardArtifact(id) {
  const hidden = hiddenDashboardArtifacts();
  hidden.add(id);
  localStorage.setItem(hiddenDashboardArtifactsKey, JSON.stringify([...hidden].slice(0, 200)));
}

function isCustomArtifact(artifact) {
  return String(artifact?.id || artifact?.publicId || '').startsWith('custom.');
}

function customChartFromPrompt(prompt, existing = null) {
  const text = normalizeText(prompt);
  const id = existing?.id || existing?.publicId || `custom.${Date.now()}`;
  const replacesArtifactId = existing?.replacesArtifactId;
  const granularity = /week|weekly|每周/.test(text) ? 'week' : 'month';
  const accountType = /credit card|credit cards|card transaction|card transactions|信用卡/.test(text) ? 'credit' : undefined;
  const wantsCount = /transaction number|transaction count|number of transaction|count of transaction|transactions by|交易数量|笔数/.test(text);
  const type = text.includes('donut') || text.includes('pie') ? 'donut'
    : text.includes('line') || text.includes('trend') ? 'line'
      : text.includes('area') ? 'area'
        : text.includes('table') ? 'table'
          : text.includes('metric') || text.includes('kpi') ? 'metric'
            : 'bar';
  let title = 'Custom cash flow';
  let dataSource = { kind: 'tool', name: 'cash_flow', params: { from: state.from, to: state.to, granularity, ...(accountType ? { accountType } : {}) } };
  let render = { type, x: 'period', y: ['income_cents', 'expense_cents', 'net_cents'], options: { yFormat: 'currency' } };
  if (wantsCount) {
    title = `${accountType === 'credit' ? 'Credit card' : 'Transaction'} count by ${granularity}`;
    dataSource = { kind: 'tool', name: 'transaction_count', params: { from: state.from, to: state.to, granularity, ...(accountType ? { accountType } : {}) } };
    render = { type: type === 'donut' ? 'bar' : type, x: 'period', y: 'transactions', options: { yFormat: 'number' } };
  } else if (text.includes('spending') || text.includes('category')) {
    title = `${accountType === 'credit' ? 'Credit card' : 'Custom'} spending by category`;
    dataSource = { kind: 'tool', name: 'spending_by_category', params: { from: state.from, to: state.to, ...(accountType ? { accountType } : {}) } };
    render = { type: type === 'line' ? 'bar' : type, x: 'category', y: 'amount_cents', options: { yFormat: 'currency' } };
  } else if (text.includes('merchant') || text.includes('vendor')) {
    title = `${accountType === 'credit' ? 'Credit card' : 'Custom'} merchant spend`;
    dataSource = { kind: 'tool', name: 'merchant_spending', params: { from: state.from, to: state.to, ...(accountType ? { accountType } : {}) } };
    render = { type: type === 'line' ? 'bar' : type, x: 'merchant', y: 'amount_cents', options: { yFormat: 'currency' } };
  } else if (text.includes('holding') || text.includes('portfolio') || text.includes('investment')) {
    title = 'Custom portfolio holdings';
    dataSource = { kind: 'tool', name: 'portfolio_holdings', params: {} };
    render = { type: type === 'line' ? 'bar' : type, x: 'symbol', y: 'value_cents', options: { yFormat: 'currency' } };
  } else if (text.includes('balance') || text.includes('account')) {
    title = 'Custom account balances';
    dataSource = { kind: 'tool', name: 'account_balances', params: {} };
    render = { type, x: 'account', y: 'balance_cents', options: { yFormat: 'currency' } };
  } else if (accountType === 'credit') {
    title = `Credit card cash flow by ${granularity}`;
  }
  return {
    id,
    publicId: id,
    name: title,
    version: 1,
    updatedAt: isoDate(today),
    ...(replacesArtifactId ? { replacesArtifactId } : {}),
    artifact: {
      title,
      description: prompt,
      dataSource,
      render,
      style: { numberFormat: 'currency' },
    },
  };
}

function account(id) {
  return state.accounts.find((candidate) => candidate.id === id);
}

function bankAccounts() {
  return state.accounts.filter((item) => item.domain !== 'brokerage');
}

function brokerageAccounts() {
  return state.accounts.filter((item) => item.domain === 'brokerage');
}

function accountLabel(id) {
  const item = account(id);
  return item ? `${item.institution} / ${item.name}` : 'Unknown account';
}

function accountProfile(item = {}) {
  const raw = `${item.institution || ''} ${item.type || ''} ${item.name || ''}`.toLowerCase();
  if (raw.includes('credit')) return { cls: 'credit', icon: 'card', label: 'Credit account' };
  if (raw.includes('savings')) return { cls: 'cash', icon: 'pig', label: 'Savings account' };
  if (item.domain === 'brokerage') {
    if (/\b(crypto|coinbase|kraken|gemini|binance|bitcoin|btc|ethereum|eth|wallet)\b/.test(raw)) return { cls: 'crypto', icon: 'crypto', label: 'Crypto account' };
    if (/401\s*\(?k\)?|retirement/.test(raw)) return { cls: 'retirement', icon: 'retirement', label: '401k or retirement account' };
    if (/\b(ira|roth|traditional|sep)\b/.test(raw)) return { cls: 'ira', icon: 'ira', label: 'IRA account' };
    return { cls: 'invest', icon: 'invest', label: 'Investment account' };
  }
  return { cls: 'cash', icon: 'bank', label: 'Bank account' };
}

function accountIcon(name) {
  const icons = {
    all: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="m4 12 8 4 8-4"/><path d="m4 17 8 4 8-4"/></svg>',
    bank: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 9 9-5 9 5"/><path d="M5 10h14"/><path d="M6 10v8"/><path d="M10 10v8"/><path d="M14 10v8"/><path d="M18 10v8"/><path d="M4 18h16"/><path d="M3 21h18"/></svg>',
    card: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h2"/><path d="M15 15h2"/></svg>',
    pig: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 11.5c0-3 2.6-5.5 6.3-5.5 2.8 0 5 1.4 5.9 3.4H21v4h-2.4c-.5 1.1-1.3 2-2.4 2.6V19h-3v-1.7h-3.5V19h-3v-3.2A5.4 5.4 0 0 1 6 11.5Z"/><path d="M6.5 10H4.8c-.8 0-1.4.6-1.4 1.4 0 .7.5 1.2 1.1 1.4"/><path d="M14 8h.01"/></svg>',
    invest: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5"/><path d="M4 19h17"/><path d="m7 15 4-4 3 3 5-7"/><path d="M17 7h2v2"/></svg>',
    crypto: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 7.5V16.5L12 21l7.5-4.5V7.5L12 3Z"/><path d="M12 8v8"/><path d="M9 10h4.2a2 2 0 0 1 0 4H9"/><path d="M9 14h5a2 2 0 0 1 0 4H9" transform="translate(0 -2)"/><path d="M10 6v2"/><path d="M14 6v2"/><path d="M10 16v2"/><path d="M14 16v2"/></svg>',
    retirement: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 16V8h3.4a2.2 2.2 0 0 1 0 4.4H8"/><path d="m12 12.4 4 3.6"/><path d="M16 8v8"/></svg>',
    ira: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21V9"/><path d="M12 9c-4.5 0-7-2.8-7-6 4.5 0 7 2.8 7 6Z"/><path d="M12 12c4.5 0 7-2.8 7-6-4.5 0-7 2.8-7 6Z"/><path d="M7 21h10"/></svg>',
  };
  return icons[name] || icons.bank;
}

function accountMask(item = {}) {
  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const candidate = metadata.mask || metadata.last4 || metadata.accountMask || item.providerAccountId || '';
  const digits = String(candidate).match(/\d{2,}$/)?.[0] || '';
  return digits ? `•••• ${digits.slice(-4)}` : '';
}

function isCreditAccount(item = {}) {
  return /credit|card/i.test(`${item.type || ''} ${item.name || ''}`);
}

function accountDisplayMinor(item, minor) {
  if (item.domain !== 'brokerage' && isCreditAccount(item)) return -Math.abs(Number(minor || 0));
  return Number(minor || 0);
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

function categoryLabel(value) {
  const text = String(value || 'Uncategorized').replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

const categoryGlyphs = [
  ['income', 'income', 'income'],
  ['salary|payroll|deposit|interest|dividend', 'income', 'income'],
  ['grocer|supermarket|market|food|dining|restaurant|coffee|bar', 'food', 'food'],
  ['utility|electric|gas|water|internet|phone|telecom', 'utility', 'home'],
  ['rent|mortgage|home|housing', 'home', 'home'],
  ['travel|airline|hotel|lodging|uber|lyft|taxi|transit|transport|parking|fuel|gas', 'travel', 'travel'],
  ['shop|store|retail|merchandise|clothing|amazon', 'shopping', 'shopping'],
  ['health|medical|doctor|pharmacy|drug|fitness|gym', 'health', 'health'],
  ['subscription|streaming|entertainment|movie|music|software', 'subscription', 'subscription'],
  ['fee|interest|atm|overdraft|service charge', 'fee', 'fee'],
  ['transfer|payment|credit card payment', 'transfer', 'transfer'],
];

function categoryProfile(value) {
  const normalized = normalizeText(value || 'uncategorized');
  for (const [pattern, icon, cls] of categoryGlyphs) {
    if (new RegExp(pattern, 'i').test(normalized)) return { icon, cls };
  }
  return { icon: 'other', cls: 'other' };
}

function categoryTooltip(value) {
  return `${categoryLabel(value)} transaction category`;
}

function categoryIconSvg(name) {
  const icons = {
    income: '<svg viewBox="0 0 20 20"><path d="M10 3v14"/><path d="M14 6.5c-.7-.8-1.9-1.3-3.4-1.3-1.8 0-3 .8-3 2.1 0 1.2 1 1.7 3.1 2.2 2.1.5 3.3 1.1 3.3 2.6 0 1.4-1.3 2.4-3.5 2.4-1.7 0-3.1-.6-4-1.6"/></svg>',
    food: '<svg viewBox="0 0 20 20"><path d="M6 3v14"/><path d="M4 3v4a2 2 0 0 0 4 0V3"/><path d="M14 3v14"/><path d="M14 3c1.7 1.2 2.5 2.6 2.5 4.3 0 1.5-.8 2.6-2.5 3.2"/></svg>',
    utility: '<svg viewBox="0 0 20 20"><path d="m11 2-6 9h5l-1 7 6-9h-5l1-7Z"/></svg>',
    home: '<svg viewBox="0 0 20 20"><path d="m3 9 7-6 7 6"/><path d="M5 8v9h10V8"/><path d="M8 17v-5h4v5"/></svg>',
    travel: '<svg viewBox="0 0 20 20"><path d="M3 12 17 5l-4 12-3-5-5-1Z"/><path d="m10 12 7-7"/></svg>',
    shopping: '<svg viewBox="0 0 20 20"><path d="M5 7h10l-1 10H6L5 7Z"/><path d="M8 7a2 2 0 0 1 4 0"/></svg>',
    health: '<svg viewBox="0 0 20 20"><path d="M10 17s-6-3.7-6-8a3.2 3.2 0 0 1 5.8-1.9L10 7.4l.2-.3A3.2 3.2 0 0 1 16 9c0 4.3-6 8-6 8Z"/><path d="M10 8.5v4"/><path d="M8 10.5h4"/></svg>',
    subscription: '<svg viewBox="0 0 20 20"><rect x="3" y="5" width="14" height="10" rx="2"/><path d="m8 8 5 2-5 2V8Z"/></svg>',
    fee: '<svg viewBox="0 0 20 20"><path d="M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z"/><path d="M10 6v5"/><path d="M10 14h.01"/></svg>',
    transfer: '<svg viewBox="0 0 20 20"><path d="M4 7h11"/><path d="m12 4 3 3-3 3"/><path d="M16 13H5"/><path d="m8 10-3 3 3 3"/></svg>',
    other: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/><path d="M10 7v3"/><path d="M10 13h.01"/></svg>',
  };
  return icons[name] || icons.other;
}

function categoryIcon(value) {
  const profile = categoryProfile(value);
  return `<span class="catmark ${esc(profile.cls)}" title="${esc(categoryTooltip(value))}" aria-label="${esc(categoryTooltip(value))}" role="img">${categoryIconSvg(profile.icon)}</span>`;
}

function categoryCell(value) {
  return `<span class="catlabel">${categoryIcon(value)}${esc(categoryLabel(value))}</span>`;
}

function setting(key) {
  return state.settings.find((item) => item.key === key) || { key, set: false, preview: '', secret: /KEY|SECRET|TOKEN|PASSWORD/i.test(key), updatedAt: null };
}

function settingValue(key, fallback = '') {
  const current = setting(key);
  return current.set ? current.preview : fallback;
}

function settingIsSet(key) {
  return Boolean(setting(key).set);
}

function selectedAccounts() {
  const accounts = state.section === 'brokerage' ? brokerageAccounts() : bankAccounts();
  return state.accountId ? accounts.filter((item) => item.id === state.accountId) : accounts;
}

function selectedTransactions() {
  return state.transactions.filter((item) => {
    if (state.accountId && item.accountId !== state.accountId) return false;
    if (state.from && item.date < state.from) return false;
    if (state.to && item.date > state.to) return false;
    return true;
  });
}

function isTransferCategory(category) {
  return /^TRANSFER(?:_|$)/i.test(String(category || ''));
}

function isSpendingTransaction(txn) {
  return Number(txn.amountMinor || 0) < 0 && !isTransferCategory(txn.category);
}

function selectedSummary() {
  const byCurrency = new Map();
  for (const txn of selectedTransactions()) {
    const current = byCurrency.get(txn.currency) || {
      currency: txn.currency,
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
    };
    if (txn.amountMinor >= 0) current.incomeMinor += txn.amountMinor;
    else current.expenseMinor += Math.abs(txn.amountMinor);
    current.netMinor += txn.amountMinor;
    byCurrency.set(txn.currency, current);
  }
  return [...byCurrency.values()];
}

function toast(text) {
  const target = $('#toast');
  target.textContent = text;
  target.classList.add('show');
  setTimeout(() => target.classList.remove('show'), 2600);
}

const dismissedInsightsKey = 'finora.dismissedInsights.v1';
const customChartsKey = 'finora.customCharts.v1';
const hiddenDashboardArtifactsKey = 'finora.hiddenDashboardArtifacts.v1';

function dismissedInsights() {
  try {
    return new Set(JSON.parse(localStorage.getItem(dismissedInsightsKey) || '[]'));
  } catch {
    return new Set();
  }
}

function saveDismissedInsights(items) {
  localStorage.setItem(dismissedInsightsKey, JSON.stringify([...items].slice(-400)));
}

function insightKey(item) {
  return [item.zone, item.group, item.title, item.detail, item.value].map((part) => String(part || '')).join('|');
}

function isInsightDismissed(item) {
  return dismissedInsights().has(insightKey(item));
}

function dismissInsightRow(row, item) {
  const dismissed = dismissedInsights();
  dismissed.add(insightKey(item));
  saveDismissedInsights(dismissed);
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const remove = () => {
    row.remove();
    renderFeed();
  };
  if (reduce) {
    remove();
    return;
  }
  row.style.maxHeight = `${row.scrollHeight}px`;
  row.getBoundingClientRect();
  row.classList.add('dismissing');
  setTimeout(() => row.classList.add('collapsing'), 130);
  setTimeout(remove, 280);
}

function closeDrawers() {
  $('.app').classList.remove('nav-open', 'chat-open');
}

function toggleDrawer(kind) {
  const app = $('.app');
  const cls = `${kind}-open`;
  const open = app.classList.contains(cls);
  app.classList.remove('nav-open', 'chat-open');
  if (!open) app.classList.add(cls);
}

function openChatDrawer() {
  $('.app').classList.remove('nav-open');
  if (window.matchMedia('(max-width: 1200px)').matches) $('.app').classList.add('chat-open');
}

function currentSectionLabel() {
  return sections.find((item) => item.id === state.section)?.label || 'Finora';
}

function contextId(type, title) {
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${type}.${Date.now().toString(36)}.${normalizeText(title).replace(/[^a-z0-9]+/g, '-').slice(0, 24) || suffix}`;
}

function textFromHtml(value) {
  const template = document.createElement('template');
  template.innerHTML = String(value ?? '');
  return (template.content.textContent || String(value ?? '')).replace(/\s+/g, ' ').trim();
}

function tableRowsForContext(headers, rows, limit = 50) {
  return rows.slice(0, limit).map((row) => Object.fromEntries(headers.map((header, index) => [
    textFromHtml(header),
    textFromHtml(Array.isArray(row) ? row[index] : row?.[index]),
  ])));
}

function chartRowsForContext(rows, limit = 80) {
  return rows.slice(0, limit).map((row) => Object.fromEntries(Object.entries(row || {}).slice(0, 12).map(([key, value]) => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return [key, value];
    return [key, String(value)];
  })));
}

function attachmentTypeLabel(type) {
  return { chart: 'Chart', item: 'Item' }[type] || 'Table';
}

function stableItemId(prefix, values) {
  const slug = normalizeText(values.join(' ')).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `${prefix}:${slug || 'row'}`;
}

function addContextAttachment(attachment) {
  const next = {
    ...attachment,
    id: attachment.id || contextId(attachment.type, attachment.title),
    section: attachment.section || state.section,
  };
  const exists = state.contextAttachments.some((item) => item.id === next.id);
  if (exists) {
    state.contextAttachments = state.contextAttachments.filter((item) => item.id !== next.id);
  } else {
    state.contextAttachments = [next, ...state.contextAttachments].slice(0, 6);
  }
  renderChat();
  if (!exists) openChatDrawer();
  $('#input').focus();
  toast(`${attachmentTypeLabel(next.type)} ${exists ? 'removed from' : 'added to'} chat context.`);
  if (!$('#modalRoot')?.children.length) render();
}

// Attach a single record (one table row or one credit-report item) to chat context.
// columns/values are parallel arrays of plain text; the attachment carries a one-row table.
function addItemContext(id, title, columns, values, section) {
  addContextAttachment({
    id,
    type: 'item',
    title,
    section,
    columns,
    rows: [Object.fromEntries(columns.map((column, index) => [column, values[index] ?? '']))],
    totalRows: 1,
  });
}

function addTableContext(id, title, headers, rows, totalRows = rows.length) {
  addContextAttachment({
    id,
    type: 'table',
    title,
    columns: headers.map(textFromHtml),
    rows: tableRowsForContext(headers, rows),
    totalRows,
    note: rows.length > 50 ? 'Only the first 50 filtered rows are included.' : undefined,
  });
}

function addChartContext(saved, rows, artifact) {
  addContextAttachment({
    id: `chart:${saved.publicId || saved.id || artifact.title || 'chart'}`,
    type: 'chart',
    title: artifact.title || saved?.name || 'Chart',
    columns: Object.keys(rows[0] || {}).slice(0, 12),
    rows: chartRowsForContext(rows),
    totalRows: rows.length,
    artifact: {
      title: artifact.title,
      description: artifact.description,
      dataSource: artifact.dataSource,
      render: artifact.render,
      style: artifact.style,
    },
    note: rows.length > 80 ? 'Only the first 80 chart rows are included.' : undefined,
  });
}

function chatContextButton(label, title) {
  const button = el('button', 'iconbtn chartaction contextsend');
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title || label);
  button.innerHTML = iconSvg('chat');
  return button;
}

function setContextButtonState(button, id) {
  const active = state.contextAttachments.some((item) => item.id === id);
  button.classList.toggle('active', active);
  button.title = active ? 'Remove from chat context' : (button.title || 'Add to chat context');
  button.setAttribute('aria-label', active ? 'Remove from chat context' : 'Add to chat context');
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function iconSvg(name) {
  const icons = {
    chat: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2h5A3.5 3.5 0 0 1 16 5.5v3A3.5 3.5 0 0 1 12.5 12H9l-4 3v-3.4A3.5 3.5 0 0 1 2 8.1V5.5Z"/><path d="M7 6h6"/><path d="M7 9h3"/></svg>',
    edit: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 14.5V17h2.5L15.4 8.1l-2.5-2.5L4 14.5Z"/><path d="m11.8 6.7 2.5 2.5"/><path d="M12.9 5.6 14 4.5a1.8 1.8 0 0 1 2.5 2.5l-1.1 1.1"/></svg>',
    trash: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14"/><path d="M8 5V3h4v2"/><path d="M6 5l.7 12h6.6L14 5"/><path d="M8.7 8v6"/><path d="M11.3 8v6"/></svg>',
  };
  return icons[name] || icons.chat;
}

function dashboardActionButton(icon, title, className = '') {
  const button = el('button', `iconbtn chartaction${className ? ` ${className}` : ''}`);
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = iconSvg(icon);
  return button;
}

function closeDashboardMenus(except = null) {
  for (const menu of document.querySelectorAll('.dashmenu')) {
    if (menu !== except) menu.remove();
  }
}

function removeDashboardArtifact(saved) {
  const id = saved.publicId || saved.id;
  if (isCustomArtifact(saved)) removeCustomDashboardArtifact(id);
  else hideDashboardArtifact(id);
  toast(isCustomArtifact(saved) ? 'Chart deleted.' : 'Widget deleted.');
  renderDashboards();
}

function removeEditableDashboardArtifact(artifact) {
  if (artifact.replacesArtifactId) {
    hideDashboardArtifact(artifact.replacesArtifactId);
    toast('Widget deleted.');
  } else {
    removeCustomDashboardArtifact(artifact.publicId || artifact.id);
    toast('Chart deleted.');
  }
  closeModal();
  renderDashboards();
}

function editableDashboardArtifact(saved) {
  if (isCustomArtifact(saved)) return saved;
  const sourceId = saved.publicId || saved.id;
  const id = `custom.${Date.now()}`;
  return {
    ...saved,
    id,
    publicId: id,
    name: saved.name || normalizeArtifact(saved).title || 'Custom chart',
    replacesArtifactId: sourceId,
    artifact: {
      ...normalizeArtifact(saved),
      description: normalizeArtifact(saved).description || normalizeArtifact(saved).title || saved.name || '',
    },
  };
}

function openDashboardActionMenu(actions, saved) {
  const existing = actions.querySelector('.dashmenu');
  if (existing) {
    existing.remove();
    return;
  }
  closeDashboardMenus();
  const menu = el('div', 'dashmenu');
  const edit = el('button');
  edit.type = 'button';
  edit.textContent = 'Edit chart';
  edit.addEventListener('click', () => {
    closeDashboardMenus();
    openChartModal(editableDashboardArtifact(saved));
  });
  menu.appendChild(edit);
  const remove = el('button', 'danger');
  remove.type = 'button';
  remove.textContent = isCustomArtifact(saved) ? 'Delete chart' : 'Delete widget';
  remove.addEventListener('click', () => removeDashboardArtifact(saved));
  menu.appendChild(remove);
  actions.appendChild(menu);
}

// Account selection is per-section. Entering a section defaults to "All
// accounts" unless a still-valid account for that section is already selected,
// so a bank account id never leaks into Brokerage (and vice versa) — which
// would leave neither a card nor the All-accounts card active.
function normalizeAccountSelection() {
  const sectionAccounts = state.section === 'brokerage' ? brokerageAccounts()
    : state.section === 'banks' ? bankAccounts()
      : [];
  if (!sectionAccounts.some((item) => item.id === state.accountId)) state.accountId = null;
}

function setSection(id) {
  state.section = id;
  normalizeAccountSelection();
  closeDrawers();
  history.replaceState(null, '', `#${id}${id === 'banks' ? `/${state.bankTab}` : ''}`);
  render();
}

// Brokerage transactions are paged (server caps limit at 300). Load every page so
// counts (the Activity card) and realized-P&L are computed over the full history,
// not just the first page.
async function fetchAllBrokerageTransactions() {
  const items = [];
  let cursor = null;
  do {
    const page = await api(`/v1/brokerage/transactions?limit=300${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...(page.items || []));
    cursor = page.nextCursor || null;
  } while (cursor);
  return items;
}

async function loadData() {
  const [
    accounts,
    summary,
    txns,
    connections,
    brokerageSummary,
    brokerageTxns,
    brokerageHoldings,
    brokerageValueSeries,
    balances,
    dashboards,
    settings,
    llm,
    rules,
    factNeeds,
    insights,
    insightMutes,
    credit,
  ] = await Promise.all([
    api('/v1/accounts'),
    api('/v1/summary'),
    api('/v1/transactions?limit=100'),
    api('/v1/provider-connections'),
    api('/v1/brokerage/summary'),
    fetchAllBrokerageTransactions(),
    api('/v1/brokerage/holdings'),
    api('/v1/brokerage/value-series'),
    api('/v1/account-balances'),
    api('/v1/dashboards'),
    api('/v1/settings'),
    api('/v1/llm'),
    api('/v1/rules'),
    api('/v1/facts/needs'),
    api('/v1/findings'),
    api('/v1/finding-mutes'),
    api('/v1/credit-reports'),
  ]);
  state.accounts = accounts.items;
  state.summary = summary.items;
  state.transactions = txns.items;
  state.recurring = null; // recomputed server-side on next Recurring tab view
  state.nextCursor = txns.nextCursor;
  state.connections = connections.items;
  state.brokerageSummary = brokerageSummary.items;
  state.brokerageTransactions = brokerageTxns;
  state.brokerageHoldings = brokerageHoldings.items;
  state.brokerageValueSeries = brokerageValueSeries.items;
  // The equity curve is server-computed per scope (needs full snapshot history,
  // which the holdings endpoint doesn't return). Seed the portfolio-wide scope
  // here; per-account scopes are fetched lazily on selection. Reset on reload so
  // a resync doesn't leave stale per-account curves cached.
  state.brokerageValueSeriesByScope = { all: brokerageValueSeries.items };
  state.brokerageValueLoading = new Set();
  state.balances = balances.items;
  state.dashboards = dashboards.items;
  state.settings = settings.items;
  state.llm = llm;
  state.notificationChannel = settingValue('NOTIFICATION_CHANNEL', state.notificationChannel);
  state.rules = rules.items;
  state.factNeeds = { byKind: factNeeds.byKind || {}, pending: factNeeds.pending || [] };
  state.insights = insights.items;
  state.insightMutes = insightMutes.items;
  state.credit = credit;
}

function renderSidebar() {
  const side = $('#sidebar');
  side.replaceChildren();
  const brand = el('div', 'brand');
  brand.innerHTML = '<span>Finora</span>';
  side.appendChild(brand);

  const nav = el('div', 'navsec');
  for (const section of sections) {
    const row = el('button', `navrow${state.section === section.id ? ' active' : ''}`);
    row.type = 'button';
    row.dataset.testid = `nav-${section.id}`;
    row.innerHTML = `<span class="lbl">${esc(section.label)}</span>`;
    row.addEventListener('click', () => setSection(section.id));
    nav.appendChild(row);
  }
  side.appendChild(nav);

  const banner = renderUpdateBanner();
  if (banner) side.appendChild(banner);
}

function dateRangeControl() {
  const wrap = el('div', 'daterange');
  wrap.innerHTML = '<span>Range</span>';
  const from = document.createElement('input');
  from.type = 'date';
  from.value = state.from;
  const to = document.createElement('input');
  to.type = 'date';
  to.value = state.to;
  const apply = el('button', 'ghost');
  apply.type = 'button';
  apply.textContent = 'Apply';
  apply.addEventListener('click', async () => {
    state.from = from.value;
    state.to = to.value;
    await loadData();
    render();
  });
  wrap.append(from, document.createTextNode('to'), to, apply);
  return wrap;
}

function topbar(title, eyebrow = 'Local finance workspace', options = {}) {
  const bar = el('div', 'topbar');
  if (!options.hideTitle) {
    const text = el('div', 'titleblock');
    text.innerHTML = `<p>${esc(eyebrow)}</p><h1>${esc(title)}</h1>`;
    bar.appendChild(text);
  }
  const controls = el('div', 'topbarcontrols');
  if (!options.hideDateRange) controls.appendChild(dateRangeControl());
  if (options.action) controls.appendChild(options.action);
  if (controls.children.length) bar.appendChild(controls);
  return bar;
}

function pageActionButton(text, id = '') {
  const button = el('button', 'primary pageaction');
  button.type = 'button';
  if (id) button.id = id;
  button.textContent = text;
  return button;
}

function manageAccountsButton(tab) {
  const button = pageActionButton('Manage accounts');
  button.textContent = 'Manage accounts';
  button.addEventListener('click', () => {
    state.settingsTab = tab;
    setSection('settings');
  });
  return button;
}

function accountCards(accounts = selectedAccounts(), label = 'accounts') {
  const grid = el('div', 'acctgrid');
  const balancesByAccount = allLatestBalances();
  const accountAmount = (item) => {
    const bal = balancesByAccount.find((row) => row.accountId === item.id);
    if (bal) {
      const minor = accountDisplayMinor(item, bal.currentMinor);
      return { label: item.domain === 'brokerage' ? 'Current value' : 'Balance', minor, value: money(minor, bal.currency) };
    }
    if (item.domain === 'brokerage') {
      const value = state.brokerageHoldings.filter((holding) => holding.accountId === item.id).reduce((sum, holding) => sum + Number(holding.valueMinor || 0), 0);
      return { label: 'Holdings value', minor: value, value: money(value, item.currency) };
    }
    const txns = state.transactions.filter((txn) => txn.accountId === item.id);
    const net = txns.reduce((sum, txn) => sum + Number(txn.amountMinor || 0), 0);
    return { label: 'Net activity', minor: net, value: money(net, txns[0]?.currency || item.currency) };
  };
  const allTotal = accounts.reduce((sum, item) => {
    const bal = balancesByAccount.find((row) => row.accountId === item.id);
    if (bal) return sum + accountDisplayMinor(item, bal.currentMinor);
    if (item.domain === 'brokerage') return sum + state.brokerageHoldings.filter((holding) => holding.accountId === item.id).reduce((inner, holding) => inner + Number(holding.valueMinor || 0), 0);
    return sum + state.transactions.filter((txn) => txn.accountId === item.id).reduce((inner, txn) => inner + Number(txn.amountMinor || 0), 0);
  }, 0);
  const allCurrency = accounts[0]?.currency || 'USD';
  const allAmountClass = allTotal < 0 ? 'neg' : 'pos';
  // 'All accounts' is highlighted only once the user has explicitly picked a card;
  // on first load nothing is preselected, though the overview still renders.
  const all = el('div', `acctcard allacct${!state.accountId && state.accountTouched ? ' active' : ''}`);
  all.innerHTML = `<div class="accticon allmark" title="All accounts" aria-label="All accounts" role="img">${accountIcon('all')}</div><div class="acctmeta"><div class="nm">All accounts</div><div class="sub">${accounts.length} account${accounts.length === 1 ? '' : 's'}</div></div><div class="acctamount ${allAmountClass}">${money(allTotal, allCurrency)}</div>`;
  all.addEventListener('click', () => {
    state.accountId = null;
    state.accountTouched = true;
    if (state.section === 'brokerage') renderBrokerage();
    else renderBanks();
  });
  grid.appendChild(all);

  for (const item of accounts) {
    const card = el('div', `acctcard${state.accountId === item.id ? ' active' : ''}`);
    const type = String(item.type || 'account').replaceAll('_', ' ');
    const profile = accountProfile(item);
    const amount = accountAmount(item);
    const mask = accountMask(item);
    const amountClass = amount.minor < 0 ? 'neg' : 'pos';
    card.innerHTML = `<div class="accticon ${esc(profile.cls)}" title="${esc(profile.label)}" aria-label="${esc(profile.label)}" role="img">${accountIcon(profile.icon)}</div><div class="acctmeta"><div class="nm">${esc(item.name)}</div><div class="sub">${esc(type)}${mask ? ` <span>${esc(mask)}</span>` : ''}</div></div><div class="acctamount ${amountClass}">${esc(amount.value)}</div>`;
    card.addEventListener('click', () => {
      state.accountId = state.accountId === item.id ? null : item.id;
      state.accountTouched = true;
      if (state.section === 'brokerage') renderBrokerage();
      else {
        state.bankTab = 'transactions';
        renderBanks();
      }
    });
    grid.appendChild(card);
  }
  return grid;
}

function summaryCards() {
  const totals = selectedSummary();
  const primary = totals[0];
  const currency = primary?.currency || selectedAccounts()[0]?.currency || 'USD';
  const income = totals.reduce((sum, item) => sum + Number(item.incomeMinor || 0), 0);
  const expense = totals.reduce((sum, item) => sum + Number(item.expenseMinor || 0), 0);
  const net = totals.reduce((sum, item) => sum + Number(item.netMinor || 0), 0);
  const txns = selectedTransactions();
  const cards = el('div', 'cards');
  cards.innerHTML = `
    <div class="card"><div class="lab">Income</div><div class="big num pos">${money(income, currency)}</div></div>
    <div class="card"><div class="lab">Spending</div><div class="big num neg">${money(expense, currency)}</div></div>
    <div class="card"><div class="lab">Net</div><div class="big num ${net < 0 ? 'neg' : 'pos'}">${money(net, currency)}</div></div>
    <div class="card"><div class="lab">Transactions</div><div class="big num">${txns.length}</div></div>
  `;
  return cards;
}

function tablePageSize(key) {
  return Number(state.tablePageSizes[key] || defaultPageSize);
}

function tableSearch(key) {
  return String(state.tableSearch[key] || '');
}

function rowSearchText(row) {
  return normalizeText(Array.isArray(row) ? row.join(' ') : Object.values(row || {}).join(' '));
}

function filterTableRows(key, rows, searchText = tableSearch(key)) {
  const needle = normalizeText(searchText);
  if (!needle) return rows;
  return rows.filter((row) => rowSearchText(row).includes(needle));
}

function focusTableSearch(key) {
  const input = Array.from(document.querySelectorAll('[data-table-search-key]'))
    .find((node) => node.dataset.tableSearchKey === key);
  if (!(input instanceof HTMLInputElement)) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function tableControls(key, rows, renderFn, itemLabel = 'transaction', contextAction = null) {
  const controls = el('div', 'tabletools');
  if (key) {
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search';
    search.dataset.tableSearchKey = key;
    search.value = tableSearch(key);
    search.addEventListener('input', () => {
      state.tableSearch[key] = search.value;
      state.tablePages[key] = 0;
      renderFn();
      focusTableSearch(key);
    });
    const size = document.createElement('select');
    for (const option of pageSizeOptions) {
      const opt = document.createElement('option');
      opt.value = String(option);
      opt.textContent = `${option} / page`;
      opt.selected = tablePageSize(key) === option;
      size.appendChild(opt);
    }
    size.addEventListener('change', () => {
      state.tablePageSizes[key] = Number(size.value);
      state.tablePages[key] = 0;
      renderFn();
    });
    controls.append(search, size);
  }
  const count = el('span', 'pginfo');
  count.textContent = `${rows.length} ${itemLabel}${rows.length === 1 ? '' : 's'}`;
  if (contextAction) controls.appendChild(contextAction);
  controls.appendChild(count);
  return controls;
}

function pagination(key, total, renderFn) {
  const size = tablePageSize(key);
  if (total <= size) return null;
  const current = Math.min(state.tablePages[key] || 0, Math.max(0, Math.ceil(total / size) - 1));
  state.tablePages[key] = current;
  const start = current * size;
  const end = Math.min(start + size, total);
  const nav = el('div', 'pager');
  const prev = el('button', 'ghost');
  prev.type = 'button';
  prev.textContent = 'Prev';
  prev.disabled = current === 0;
  prev.addEventListener('click', () => {
    state.tablePages[key] = Math.max(0, current - 1);
    renderFn();
  });
  const info = el('span', 'pginfo');
  info.textContent = `${start + 1}-${end} of ${total}`;
  const next = el('button', 'ghost');
  next.type = 'button';
  next.textContent = 'Next';
  next.disabled = end >= total;
  next.addEventListener('click', () => {
    state.tablePages[key] = current + 1;
    renderFn();
  });
  nav.append(prev, info, next);
  return nav;
}

function pageRows(key, rows) {
  const size = tablePageSize(key);
  const page = Math.min(state.tablePages[key] || 0, Math.max(0, Math.ceil(rows.length / size) - 1));
  state.tablePages[key] = page;
  return rows.slice(page * size, page * size + size);
}

function renderDataTable(headers, rows, options = {}) {
  const key = options.pageKey;
  const renderFn = options.render || render;
  const filtered = key ? filterTableRows(key, rows) : rows;
  const visibleRows = key ? pageRows(key, filtered) : filtered;
  const wrap = el('div', 'table-wrap');
  wrap.dataset.testid = 'data-table';
  const contextTitle = options.contextTitle || `${currentSectionLabel()} table: ${headers.map(textFromHtml).slice(0, 3).join(', ')}`;
  const contextIdValue = `table:${key || normalizeText(contextTitle).replace(/[^a-z0-9]+/g, '-') || headers.map(textFromHtml).join('-')}`;
  const contextAction = options.context === false ? null : chatContextButton('Chat', 'Add this table to chat context');
  if (contextAction) {
    setContextButtonState(contextAction, contextIdValue);
    contextAction.addEventListener('click', () => addTableContext(contextIdValue, contextTitle, headers, filtered, filtered.length));
  }
  if (key || contextAction) wrap.appendChild(tableControls(key, filtered, renderFn, options.itemLabel, contextAction));
  const table = document.createElement('table');
  const headerCells = headers.map((header, index) => `<th class="${index ? 'r' : ''}">${esc(header)}</th>`).join('');
  table.innerHTML = `<thead><tr>${headerCells}</tr></thead>`;
  const body = document.createElement('tbody');
  if (!visibleRows.length) {
    body.innerHTML = `<tr><td colspan="${headers.length}" class="empty">${esc(options.emptyText || 'No rows match.')}</td></tr>`;
  }
  for (const row of visibleRows) {
    const tr = document.createElement('tr');
    tr.innerHTML = row.map((cell, index) => `<td class="${index ? 'r' : ''}">${cell}</td>`).join('');
    if (options.onRowClick && row.meta !== undefined) {
      tr.classList.add('clickable');
      tr.addEventListener('click', () => options.onRowClick(row.meta));
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  if (key) {
    const pager = pagination(key, filtered.length, renderFn);
    if (pager) wrap.appendChild(pager);
  }
  return wrap;
}

function renderSubnav(tabs = bankTabs, activeId = state.bankTab, onSelect = () => {}) {
  const subnav = el('div', 'subnav');
  for (const [id, label] of tabs) {
    const tab = el('div', `subtab${activeId === id ? ' active' : ''}`);
    tab.dataset.testid = `subtab-${id}`;
    tab.textContent = label;
    tab.addEventListener('click', () => {
      onSelect(id);
    });
    subnav.appendChild(tab);
  }
  return subnav;
}

function renderBanks() {
  state.section = 'banks';
  renderSidebar();
  const view = $('#view');
  view.replaceChildren(topbar('Banking', 'Imported from Plaid', { hideDateRange: true, action: manageAccountsButton('banks') }));
  const accounts = bankAccounts();
  if (!accounts.length) {
    view.appendChild(accountCta('No bank accounts yet', 'Connect a bank through Plaid Link. Bank statement import is not supported in this build.', 'Add bank account', () => openProviderConnection()));
    return;
  }
  view.appendChild(accountCards(accounts, 'Banks'));
  view.appendChild(renderSubnav(bankTabs, state.bankTab, (id) => {
    state.bankTab = id;
    history.replaceState(null, '', `#banks/${id}`);
    renderBanks();
  }));
  if (state.bankTab === 'summary') renderBankSummary(view);
  if (state.bankTab === 'transactions') renderBankTransactions(view);
  if (state.bankTab === 'cashflow') renderBankCashflow(view);
  if (state.bankTab === 'recurring') renderBankRecurring(view);
  renderSuggest();
}

function bankSpendingByCategory(rows = selectedTransactions()) {
  const byCategory = new Map();
  for (const txn of rows.filter(isSpendingTransaction)) {
    const key = txn.category || 'Uncategorized';
    const current = byCategory.get(key) || { category: key, count: 0, amount: 0, currency: txn.currency };
    current.count += 1;
    current.amount += Math.abs(txn.amountMinor);
    byCategory.set(key, current);
  }
  return [...byCategory.values()].sort((a, b) => b.amount - a.amount);
}

function topMerchants(rows = selectedTransactions()) {
  const byMerchant = new Map();
  for (const txn of rows.filter(isSpendingTransaction)) {
    const key = txn.description || 'Unknown';
    const current = byMerchant.get(key) || { merchant: key, count: 0, amount: 0, currency: txn.currency };
    current.count += 1;
    current.amount += Math.abs(txn.amountMinor);
    byMerchant.set(key, current);
  }
  return [...byMerchant.values()].sort((a, b) => b.amount - a.amount);
}

// Recurring detection is server-side: the backend classifies each merchant series
// with the configured AI model (subscription, bill, income, …) and returns only
// the recurring ones. Fetched lazily into state.recurring and re-rendered.
async function loadRecurring() {
  if (state.recurringLoading) return;
  state.recurringLoading = true;
  try {
    state.recurring = await api('/v1/recurring');
  } catch (error) {
    state.recurring = { status: 'error', message: error instanceof Error ? error.message : 'Failed to load recurring transactions' };
  } finally {
    state.recurringLoading = false;
    if (state.section === 'banks' && state.bankTab === 'recurring') renderBanks();
  }
}

const RECURRING_KIND_LABELS = {
  subscription: 'Subscription', membership: 'Membership', bill: 'Bill',
  insurance: 'Insurance', loan: 'Loan', rent: 'Rent', income: 'Income', other: 'Recurring',
};

function recurringModelPrompt(data) {
  const box = el('div', 'empty');
  const line = el('p');
  line.textContent = data.needsDownload
    ? 'Recurring detection uses an AI model to identify subscriptions, bills, and income. Set up the built-in model to enable it.'
    : 'Recurring detection uses an AI model to identify subscriptions, bills, and income. Connect a model to enable it.';
  box.appendChild(line);
  const button = el('button', 'primary');
  button.type = 'button';
  button.textContent = data.needsDownload ? 'Set up the model' : 'Connect a model';
  button.addEventListener('click', () => {
    state.settingsTab = 'models';
    setSection('settings');
  });
  box.appendChild(button);
  return box;
}

function renderBankSummary(view) {
  view.appendChild(summaryCards());
  const spending = bankSpendingByCategory();
  const categories = el('div', 'sec');
  categories.innerHTML = '<div class="sechdr"><h3>Spending by category</h3></div>';
  categories.appendChild(spending.length
    ? transactionLikeTable(['Category', 'Transactions', 'Spent'], spending.map((row) => [
      categoryCell(row.category),
      `<span class="pill">${row.count}</span>`,
      `<span class="num neg">${money(row.amount, row.currency)}</span>`,
    ]), { pageKey: `bank-categories-${state.accountId || 'all'}-${state.from}-${state.to}` })
    : empty('No spending in this range.'));
  view.appendChild(categories);

  const merchants = topMerchants();
  const top = el('div', 'sec');
  top.innerHTML = '<div class="sechdr"><h3>Top merchants</h3></div>';
  top.appendChild(merchants.length
    ? transactionLikeTable(['Merchant', 'Transactions', 'Spent'], merchants.map((row) => [
      esc(row.merchant),
      `<span class="pill">${row.count}</span>`,
      `<span class="num neg">${money(row.amount, row.currency)}</span>`,
    ]), { pageKey: `bank-merchants-${state.accountId || 'all'}-${state.from}-${state.to}` })
    : empty('No merchant spending in this range.'));
  view.appendChild(top);
}

function renderBankTransactions(view) {
  const sec = el('div', 'sec');
  const selected = account(state.accountId);
  sec.innerHTML = `<div class="sechdr"><h3>Transactions</h3><span class="pill">${selected ? esc(selected.name) : 'All accounts'}</span></div>`;
  const key = `bank-transactions-${state.accountId || 'all'}-${state.from}-${state.to}`;
  const rows = selectedTransactions().map((txn) => [
    esc(txn.date),
    esc(txn.description),
    categoryCell(txn.category),
    esc(accountLabel(txn.accountId)),
    `<span class="num ${txn.amountMinor < 0 ? 'neg' : 'pos'}">${money(txn.amountMinor, txn.currency)}</span>`,
  ]);
  sec.appendChild(renderDataTable(['Date', 'Description', 'Category', 'Account', 'Amount'], rows, { pageKey: key, render: renderBanks, emptyText: 'No transactions match.' }));
  view.appendChild(sec);
}

function renderBankCashflow(view) {
  const rows = selectedTransactions();
  const byMonth = new Map();
  for (const txn of rows) {
    const key = txn.date.slice(0, 7);
    const current = byMonth.get(key) || { month: key, income: 0, expense: 0, net: 0, currency: txn.currency };
    if (txn.amountMinor >= 0) current.income += txn.amountMinor;
    else current.expense += Math.abs(txn.amountMinor);
    current.net += txn.amountMinor;
    byMonth.set(key, current);
  }
  const data = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  const sec = el('div', 'sec');
  sec.innerHTML = '<div class="sechdr"><h3>Monthly cash flow</h3></div>';
  if (!data.length) {
    sec.appendChild(empty('No cash-flow data yet.'));
  } else {
    sec.appendChild(transactionLikeTable(['Month', 'Income', 'Spending', 'Net'], data.map((row) => [
      row.month,
      `<span class="num pos">${money(row.income, row.currency)}</span>`,
      `<span class="num neg">${money(row.expense, row.currency)}</span>`,
      `<span class="num ${row.net < 0 ? 'neg' : 'pos'}">${money(row.net, row.currency)}</span>`,
    ]), { pageKey: `bank-cashflow-${state.accountId || 'all'}` }));
  }
  view.appendChild(sec);
}

function renderBankRecurring(view) {
  const sec = el('div', 'sec');
  sec.innerHTML = `<div class="sechdr"><h3>Recurring</h3></div>`;
  const data = state.recurring;
  if (!data) {
    sec.appendChild(empty('Detecting recurring transactions…'));
    loadRecurring();
  } else if (data.status === 'model_required') {
    sec.appendChild(recurringModelPrompt(data));
  } else if (data.status === 'error') {
    sec.appendChild(empty(data.message || 'Could not load recurring transactions.'));
  } else if (!data.items || !data.items.length) {
    sec.appendChild(empty('No recurring transactions detected yet.'));
  } else {
    sec.appendChild(transactionLikeTable(['Merchant', 'Type', 'Cadence', 'Transactions', 'Typical', 'Last seen'], data.items.map((item) => {
      const row = [
        esc(item.merchant),
        `<span class="pill">${esc(RECURRING_KIND_LABELS[item.kind] || 'Recurring')}</span>`,
        esc(item.cadence || '—'),
        `<span class="pill">${item.count}</span>`,
        `<span class="num ${item.direction === 'in' ? 'pos' : 'neg'}">${money(item.amountMinor, item.currency)}</span>`,
        esc(item.lastDate),
      ];
      row.meta = item; // carried through filter/pagination for the row click
      return row;
    }), { pageKey: 'bank-recurring', onRowClick: openRecurringDetail }));
  }
  view.appendChild(sec);
}

// Drill-down: every transaction behind a recurring row.
function openRecurringDetail(item) {
  const content = el('div', 'sec');
  const head = el('div', 'sechdr');
  const cadence = item.cadence && item.cadence !== 'irregular' ? ` · ${esc(item.cadence)}` : '';
  head.innerHTML = `<h3>${esc(item.merchant)}</h3><span class="pill">${esc(RECURRING_KIND_LABELS[item.kind] || 'Recurring')}${cadence}</span>`;
  content.appendChild(head);
  const rows = (item.transactions || []).map((tx) => [
    esc(tx.date),
    esc(tx.description),
    esc(accountLabel(tx.accountId)),
    `<span class="num ${tx.amountMinor < 0 ? 'neg' : 'pos'}">${money(tx.amountMinor, tx.currency)}</span>`,
  ]);
  content.appendChild(renderDataTable(['Date', 'Description', 'Account', 'Amount'], rows, { context: false, emptyText: 'No transactions.' }));
  modal(content);
}

function transactionLikeTable(headers, rows, options = {}) {
  return renderDataTable(headers, rows, options);
}

function empty(text) {
  const node = el('div', 'empty');
  node.textContent = text;
  return node;
}

function accountCta(title, text, buttonText, onClick) {
  const panel = el('div', 'feedpanel');
  panel.innerHTML = `<div class="feedhead"><div><div class="kicker">Setup</div><div class="feedtitle">${esc(title)}</div></div><button class="primary" id="ctaAction">${esc(buttonText)}</button></div><div class="cardsub">${esc(text)}</div>`;
  panel.querySelector('#ctaAction').addEventListener('click', onClick);
  return panel;
}

function buildFeedItems() {
  // Findings arrive ranked by score. Lead with the dollar impact when the finding
  // carries one, since that is the ranking signal; fall back to the raw value.
  return state.insights.map((insight) => ({
    zone: insight.severity === 'high' ? 'attention' : 'insights',
    group: insightGroup(insight),
    icon: insightIcon(insight),
    title: insight.title,
    detail: insight.detail,
    value: findingImpactLabel(insight),
    amount: insight.dollarImpactMinor || 0,
    id: insight.id,
    kind: insight.kind,
    // evidence.records[0] for a connection finding is "provider:external_id" — the
    // handle we use to jump to the right connection in Settings for re-auth.
    connectionKey: insight.evidence?.records?.[0] || null,
    artifactType: insight.action?.artifactType || null,
  }));
}

// A connection finding (expiring soon, or already lapsed) that we can route to a
// one-tap Plaid re-auth in Settings. Plaid-only: SnapTrade uses a different flow.
function isReconnectItem(item) {
  return (item.kind === 'connection-health' || item.kind === 'connection-consent-expiring')
    && typeof item.connectionKey === 'string' && item.connectionKey.startsWith('plaid:');
}

// Send the user to Settings ▸ Bank/Brokerage with the target connection highlighted,
// where the existing update-mode reconnect button lives.
function openReconnectFromInsight(item) {
  const key = item.connectionKey || '';
  state.settingsTab = 'accounts';
  state.highlightConnection = key.slice(key.indexOf(':') + 1) || null;
  setSection('settings');
}

// Short label for the "draft this for me" button, by artifact type.
function artifactLabel(type) {
  return ({
    'dispute-letter': 'Draft dispute letter',
    'fee-waiver-request': 'Draft waiver request',
    'apr-reduction-request': 'Draft APR script',
    'retention-script': 'Draft negotiation script',
  })[type] || 'Draft document';
}

function findingImpactLabel(finding) {
  if (finding.dollarImpactMinor) {
    const amount = money(finding.dollarImpactMinor, finding.currency || 'USD');
    const confidence = typeof finding.confidence === 'number' ? ` · ${Math.round(finding.confidence * 100)}%` : '';
    return `${amount}${confidence}`;
  }
  return finding.value || finding.severity;
}

function insightGroup(insight) {
  const scope = String(insight.scope || insight.kind || '').toLowerCase();
  if (/brokerage|portfolio|holding|cash_drag/.test(scope)) return 'Portfolio';
  if (/credit|card/.test(scope)) return 'Credit';
  if (/connection|plaid|provider/.test(scope)) return 'Connections';
  if (/transaction|spending|cash|banking/.test(scope)) return 'Cash flow';
  return 'Rules';
}

function insightIcon(insight) {
  if (insight.severity === 'high') return '!';
  if (/portfolio|brokerage|cash/.test(`${insight.scope || ''} ${insight.kind || ''}`)) return '$';
  if (/credit|card/.test(`${insight.scope || ''} ${insight.kind || ''}`)) return '%';
  return '*';
}

function renderFeedZone(panel, title, zone, items) {
  if (!items.length) return;
  const wrap = el('div', `feedzone ${zone}`);
  if (title) wrap.innerHTML = `<div class="feedlabel">${esc(title)} <span class="zonecount">${items.length}</span></div>`;
  const groups = new Map();
  for (const item of items) {
    const list = groups.get(item.group) || [];
    list.push(item);
    groups.set(item.group, list);
  }
  for (const [group, rows] of groups) {
    const block = el('div', 'feedgroup');
    block.innerHTML = `<div class="feedgroup-title">${esc(group)} <span class="count">${rows.length}</span></div>`;
    for (const item of rows) {
      const row = el('div', 'feedrow');
      const draftBtn = item.artifactType
        ? `<button type="button" class="draftbtn" title="Draft a document you can review and send yourself">✎ ${esc(artifactLabel(item.artifactType))}</button>`
        : '';
      const reconnectBtn = isReconnectItem(item)
        ? `<button type="button" class="reconnectbtn" title="Reconnect this bank in Settings">↻ Reconnect</button>`
        : '';
      row.innerHTML = `<div class="feedico ${esc(zone)}">${esc(item.icon)}</div><div class="feedcopy"><div class="t">${esc(item.title)}</div><div class="d">${esc(item.detail)}</div></div><div class="feedactions"><span class="valuechip ${item.amount < 0 ? 'neg' : item.amount > 0 ? 'pos' : ''}">${esc(item.value)}</span>${reconnectBtn}${draftBtn}<button type="button" class="dismissbtn" title="Dismiss" aria-label="Dismiss insight">×</button></div>`;
      row.querySelector('.dismissbtn').addEventListener('click', () => dismissInsightRow(row, item));
      if (reconnectBtn) row.querySelector('.reconnectbtn').addEventListener('click', () => openReconnectFromInsight(item));
      if (item.artifactType) row.querySelector('.draftbtn').addEventListener('click', (event) => generateArtifact(event.currentTarget, row, item));
      block.appendChild(row);
    }
    wrap.appendChild(block);
  }
  panel.appendChild(wrap);
}

function renderFeed() {
  const view = $('#view');
  view.replaceChildren(topbar('Insights', 'Local review queue', { hideTitle: true, hideDateRange: true }));
  const panel = el('div', 'feedpanel');
  const items = buildFeedItems().filter((item) => item.zone !== 'activity' && !isInsightDismissed(item));
  const attention = items.filter((item) => item.zone === 'attention');
  const regular = items.filter((item) => item.zone === 'insights');
  if (!items.length) {
    panel.appendChild(empty('No current insights.'));
  } else {
    renderFeedZone(panel, 'Needs attention', 'attention', attention);
    renderFeedZone(panel, '', 'insights', regular);
  }
  view.appendChild(panel);
}

// Ask the backend to draft the Advisor document for a finding, then reveal it
// inline beneath the row. Grounding and money math happen server-side; this only
// requests and displays. Finora drafts for review — it never sends anything.
async function generateArtifact(btn, row, item) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Drafting…';
  try {
    const res = await api('/v1/findings/artifact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id }),
    });
    if (res.status === 'ok') {
      showArtifact(row, res.title, res.artifact, true);
    } else if (res.status === 'model_required') {
      const how = res.needsDownload ? 'download the built-in model' : 'add a provider API key';
      showArtifact(row, null, `A language model is required to draft this. Open Settings → Models to ${how}.`, false);
    } else {
      showArtifact(row, null, 'This insight can no longer be drafted.', false);
    }
  } catch (error) {
    showArtifact(row, null, error.message || 'Could not draft this document.', false);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// Insert or replace the drafted-document box directly after a finding row. When
// a real draft is shown, offer a Copy button; messages (model required, errors)
// render as a plain note.
function showArtifact(row, title, text, copyable) {
  let box = row.nextElementSibling;
  if (!box || !box.classList.contains('artifactbox')) {
    box = el('div', 'artifactbox');
    row.after(box);
  }
  box.replaceChildren();
  if (title) {
    const head = el('div', 'artifacttitle');
    head.textContent = title;
    box.appendChild(head);
  }
  const body = el('pre', 'artifacttext');
  body.textContent = text;
  box.appendChild(body);
  const foot = el('div', 'artifactfoot');
  const note = el('span', 'artifactnote');
  note.textContent = copyable ? 'Draft for your review — Finora does not send this for you.' : '';
  foot.appendChild(note);
  if (copyable && navigator.clipboard) {
    const copy = el('button', 'copybtn');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      }).catch(() => {});
    });
    foot.appendChild(copy);
  }
  box.appendChild(foot);
}

function selectedBrokerageTransactions() {
  return state.brokerageTransactions.filter((item) => {
    if (state.accountId && item.accountId !== state.accountId) return false;
    if (state.from && item.date < state.from) return false;
    if (state.to && item.date > state.to) return false;
    return true;
  });
}

// A crypto exchange has no cash concept: Plaid reports the whole balance as a
// single CUR:USD cash-equivalent line, but that is the crypto's market value, not
// spendable cash. So a cash-type line on such an account is treated as a position.
function isCryptoAccount(item) {
  return (item?.type || '').toLowerCase().includes('crypto');
}

// Providers report uninvested cash as a pseudo-security holding (Plaid marks it
// security type 'cash', ticker CUR:USD). It is the account's cash, not a
// position, so callers separate it from real holdings — except on crypto
// exchanges (see isCryptoAccount), where that line is the crypto's market value.
function isCashHolding(holding) {
  if ((holding.securityType || '').toLowerCase() !== 'cash') return false;
  return !isCryptoAccount(account(holding.accountId));
}

function selectedBrokerageHoldings() {
  // Match the server's snapshot semantics (summarizeBrokerage / brokerageValueSeries):
  // an account's holdings are those from its most recent snapshot date. Providers
  // send a full snapshot each sync, so a position sold before the latest sync must
  // not linger from an older snapshot — otherwise Market value / Cash / P&L (all
  // derived from this list) overcount by resurrecting closed positions. The
  // holdings endpoint already returns one row per (account, security) at its
  // latest-seen date, so keeping only rows on the account's max date yields
  // exactly that account's current snapshot.
  const scoped = state.brokerageHoldings.filter((item) => !state.accountId || item.accountId === state.accountId);
  const latestDate = new Map();
  for (const item of scoped) {
    const current = latestDate.get(item.accountId);
    if (!current || item.asOfDate > current) latestDate.set(item.accountId, item.asOfDate);
  }
  // An account whose latest balance snapshot is newer than its latest holdings
  // snapshot was re-synced with no holdings (emptied), so its old holdings are
  // stale — drop them so Market value / Cash / P&L don't show a closed account.
  const latestBalanceDate = new Map();
  for (const item of state.balances) {
    const current = latestBalanceDate.get(item.accountId);
    if (!current || item.asOfDate > current) latestBalanceDate.set(item.accountId, item.asOfDate);
  }
  return scoped
    .filter((item) => item.asOfDate === latestDate.get(item.accountId))
    .filter((item) => {
      const balanceDate = latestBalanceDate.get(item.accountId);
      return !balanceDate || balanceDate <= item.asOfDate;
    })
    .sort((a, b) => Number(b.valueMinor || 0) - Number(a.valueMinor || 0));
}

function selectedBalances() {
  return state.balances.filter((item) => !state.accountId || item.accountId === state.accountId);
}

function latestBalancesFrom(rows) {
  const byAccount = new Map();
  for (const item of rows) {
    const current = byAccount.get(item.accountId);
    if (!current || item.asOfDate > current.asOfDate) byAccount.set(item.accountId, item);
  }
  return [...byAccount.values()];
}

function latestBalances() {
  return latestBalancesFrom(selectedBalances());
}

// Every account card shows its own real balance regardless of which account is
// selected, so it must read from the full balance set — not the account-scoped
// selectedBalances(), which would leave the other cards to fall back to a
// transaction-net figure and appear to change when a selection is made.
function allLatestBalances() {
  return latestBalancesFrom(state.balances);
}

function renderBrokerage() {
  state.section = 'brokerage';
  renderSidebar();
  const view = $('#view');
  view.replaceChildren(topbar('Brokerage', 'Imported investment accounts', { hideDateRange: true, action: manageAccountsButton('brokerage') }));
  const accounts = brokerageAccounts();
  if (!accounts.length) {
    view.appendChild(accountCta('No brokerage accounts yet', 'Connect a brokerage account through Plaid Link. Bank statement import is not used for brokerage data.', 'Add brokerage account', () => openProviderConnection()));
    return;
  }
  view.appendChild(accountCards(accounts, 'Brokerage'));
  view.appendChild(renderSubnav(brokerageTabs, state.brokerageTab, (id) => {
    state.brokerageTab = id;
    history.replaceState(null, '', `#brokerage/${id}`);
    renderBrokerage();
  }));
  if (state.brokerageTab === 'transactions') {
    renderBrokerageTransactions(view);
    renderSuggest();
    return;
  }
  renderBrokerageSummary(view);
  renderSuggest();
}

function renderBrokerageSummary(view) {
  view.appendChild(brokerageSummaryCards());
  view.appendChild(brokerageValueChart());

  const balances = latestBalances();
  if (balances.length) {
    const sec = el('div', 'sec');
    sec.innerHTML = '<div class="sechdr"><h3>Latest balances</h3></div>';
    sec.appendChild(transactionLikeTable(
      ['Account', 'As of', 'Current', 'Cash', 'Buying power'],
      balances.map((row) => [
        esc(accountLabel(row.accountId)),
        esc(row.asOfDate),
        `<span class="num">${money(row.currentMinor, row.currency)}</span>`,
        row.cashMinor === null ? '<span class="mut">-</span>' : `<span class="num">${money(row.cashMinor, row.currency)}</span>`,
        row.buyingPowerMinor === null ? '<span class="mut">-</span>' : `<span class="num">${money(row.buyingPowerMinor, row.currency)}</span>`,
      ]),
      { pageKey: `brokerage-balances-${state.accountId || 'all'}`, itemLabel: 'balance' },
    ));
    view.appendChild(sec);
  }

  const holdings = el('div', 'sec');
  holdings.innerHTML = '<div class="sechdr"><h3>Holdings</h3></div>';
  // Cash pseudo-holdings surface in the Cash tile, not this positions table.
  const holdingRows = selectedBrokerageHoldings().filter((row) => !isCashHolding(row)).slice(0, 80);
  if (!holdingRows.length) holdings.appendChild(empty('No holdings in this scope.'));
  else holdings.appendChild(transactionLikeTable(
    ['Symbol', 'Name', 'Quantity', 'Price', 'Value', 'Cost basis', 'Unrealized P&L', 'P&L %'],
    holdingRows.map((row) => {
      const hasCost = row.costBasisMinor !== null && row.costBasisMinor !== undefined;
      const pnl = hasCost ? Number(row.valueMinor || 0) - Number(row.costBasisMinor || 0) : null;
      const pnlPct = hasCost && Number(row.costBasisMinor) ? (pnl / Number(row.costBasisMinor)) * 100 : null;
      return [
        esc(row.symbol || '-'),
        esc(row.name || row.securityType || '-'),
        esc(row.quantity || '-'),
        row.priceMinor === null ? '<span class="mut">-</span>' : `<span class="num">${money(row.priceMinor, row.currency)}</span>`,
        `<span class="num">${money(row.valueMinor, row.currency)}</span>`,
        hasCost ? `<span class="num">${money(row.costBasisMinor, row.currency)}</span>` : '<span class="mut">-</span>',
        hasCost ? `<span class="num ${pnl < 0 ? 'neg' : 'pos'}">${money(pnl, row.currency)}</span>` : '<span class="mut">-</span>',
        pnlPct === null ? '<span class="mut">-</span>' : `<span class="num ${pnlPct < 0 ? 'neg' : 'pos'}">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</span>`,
      ];
    }),
    { pageKey: `brokerage-holdings-${state.accountId || 'all'}`, itemLabel: 'holding' },
  ));
  view.appendChild(holdings);
}

function renderBrokerageTransactions(view) {
  const txns = el('div', 'sec');
  const selected = account(state.accountId);
  txns.innerHTML = `<div class="sechdr"><h3>Transactions</h3><span class="pill">${selected ? esc(selected.name) : 'All accounts'}</span></div>`;
  const rows = selectedBrokerageTransactions();
  if (!rows.length) txns.appendChild(empty('No brokerage transactions in this scope.'));
  else txns.appendChild(transactionLikeTable(
    ['Date', 'Description', 'Symbol', 'Type', 'Quantity', 'Price', 'Amount'],
    rows.map((row) => [
      esc(row.date),
      esc(row.description),
      esc(row.symbol || '-'),
      esc(row.investmentType || row.category || '-'),
      esc(row.quantity || '-'),
      row.priceMinor === null ? '<span class="mut">-</span>' : `<span class="num">${money(row.priceMinor, row.currency)}</span>`,
      `<span class="num ${row.amountMinor < 0 ? 'neg' : 'pos'}">${money(row.amountMinor, row.currency)}</span>`,
    ]),
    { pageKey: `brokerage-transactions-${state.accountId || 'all'}-${state.from}-${state.to}` },
  ));
  view.appendChild(txns);
}

function brokerageSummaryCards() {
  const holdings = selectedBrokerageHoldings();
  const txns = selectedBrokerageTransactions();
  const balances = latestBalances();
  const currency = holdings[0]?.currency || balances[0]?.currency || selectedAccounts()[0]?.currency || 'USD';
  // Providers report uninvested cash as a pseudo-security holding (Plaid: type
  // 'cash', ticker CUR:USD). Treat it as cash, not an investment: keep it out of
  // Market value and fold it into the Cash tile.
  const positions = holdings.filter((item) => !isCashHolding(item));
  const value = positions.reduce((sum, item) => sum + Number(item.valueMinor || 0), 0);
  // Cash = cash-type holdings + balance cash for accounts without one (so an
  // account is never counted through both paths). SnapTrade sets cashMinor on the
  // balance directly and has no cash holding; Plaid does the reverse.
  const cashHoldings = holdings.filter((item) => isCashHolding(item));
  const accountsWithCashHoldings = new Set(cashHoldings.map((item) => item.accountId));
  const cashFromHoldings = cashHoldings.reduce((sum, item) => sum + Number(item.valueMinor || 0), 0);
  const cashFromBalances = balances
    .filter((item) => !accountsWithCashHoldings.has(item.accountId))
    .reduce((sum, item) => sum + Number(item.cashMinor || 0), 0);
  const cash = cashFromHoldings + cashFromBalances;
  // Buying power is a margin figure most providers (e.g. Plaid) never report;
  // show a dash rather than a misleading total when no account exposes one.
  const bpBalances = balances.filter((item) => item.buyingPowerMinor !== null && item.buyingPowerMinor !== undefined);
  const buyingPower = bpBalances.length
    ? bpBalances.reduce((sum, item) => sum + Number(item.buyingPowerMinor || 0), 0)
    : null;
  // Unrealized P&L is only defined where the provider gave us a cost basis;
  // holdings without one are excluded from both the gain and the cost base so
  // the percentage stays honest. Note partial coverage on the card itself.
  const withCost = positions.filter((item) => item.costBasisMinor !== null && item.costBasisMinor !== undefined);
  const costBasis = withCost.reduce((sum, item) => sum + Number(item.costBasisMinor || 0), 0);
  const unrealized = withCost.reduce((sum, item) => sum + (Number(item.valueMinor || 0) - Number(item.costBasisMinor || 0)), 0);
  const pnlPct = costBasis ? (unrealized / costBasis) * 100 : null;
  const pnlLabel = withCost.length
    ? `Unrealized P&L${pnlPct === null ? '' : ` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`}`
    : 'Unrealized P&L';
  const coverageNote = withCost.length && withCost.length < positions.length
    ? ` title="Based on ${withCost.length} of ${positions.length} holdings with a known cost basis"`
    : '';
  const pnlValue = withCost.length
    ? `<div class="big num ${unrealized < 0 ? 'neg' : 'pos'}">${money(unrealized, currency)}</div>`
    : '<div class="big num mut">-</div>';
  const cards = el('div', 'cards');
  cards.innerHTML = `
    <div class="card"><div class="lab">Market value</div><div class="big num">${money(value, currency)}</div></div>
    <div class="card"${coverageNote}><div class="lab">${pnlLabel}</div>${pnlValue}</div>
    <div class="card"><div class="lab">Cash</div><div class="big num">${money(cash, currency)}</div></div>
    <div class="card"><div class="lab">Buying power</div>${buyingPower === null ? '<div class="big num mut">-</div>' : `<div class="big num">${money(buyingPower, currency)}</div>`}</div>
    <div class="card"><div class="lab">Activity</div><div class="big num">${txns.length}</div></div>
  `;
  return cards;
}

// Lazily load the equity curve for a scope ('all' or an accountId). The series is
// server-computed (it needs full snapshot history, which the holdings endpoint
// collapses to the latest per security), so scoping to an account means fetching
// that account's curve rather than filtering client-side.
async function fetchBrokerageValueSeries(scope) {
  if (state.brokerageValueLoading.has(scope)) return;
  state.brokerageValueLoading.add(scope);
  try {
    const query = scope === 'all' ? '' : `?accountId=${encodeURIComponent(scope)}`;
    const res = await api(`/v1/brokerage/value-series${query}`);
    state.brokerageValueSeriesByScope[scope] = res.items || [];
  } catch (error) {
    console.warn('Failed to load value series for', scope, error);
    state.brokerageValueSeriesByScope[scope] = [];
  } finally {
    state.brokerageValueLoading.delete(scope);
    if (state.section === 'brokerage' && state.brokerageTab === 'summary') renderBrokerage();
  }
}

function brokerageValueChart() {
  const sec = el('div', 'sec');
  sec.innerHTML = '<div class="sechdr"><h3>Value over time</h3></div>';
  const scope = state.accountId || 'all';
  const series = state.brokerageValueSeriesByScope[scope];
  if (series === undefined) {
    fetchBrokerageValueSeries(scope);
    sec.appendChild(empty('Loading value history…'));
    return sec;
  }
  // Plot a single currency (the most recent point's), matching the single-currency
  // convention used across the brokerage summary.
  const currency = series.length ? series[series.length - 1].currency : (selectedBrokerageHoldings()[0]?.currency || 'USD');
  const points = series.filter((point) => point.currency === currency);
  if (points.length < 2) {
    sec.appendChild(empty('Not enough history yet — the value curve builds up as the app syncs each day.'));
    return sec;
  }
  // Pick a tick granularity from the span so the axis reads in days for short
  // history and coarsens to weeks/months/years as it grows — never sub-day.
  const spanDays = (Date.parse(points[points.length - 1].date) - Date.parse(points[0].date)) / 86400000;
  const [xTickInterval, xLabelFormat] = spanDays <= 31 ? ['day', '%b %d']
    : spanDays <= 182 ? ['week', '%b %d']
    : spanDays <= 730 ? ['month', '%b %Y']
    : ['year', '%Y'];
  const host = el('div');
  sec.appendChild(host);
  renderArtifactChart(host, {
    name: 'Value over time',
    artifact: {
      title: 'Value over time',
      description: `Holdings market value · ${currency}`,
      render: { type: 'area', x: 'date', y: 'value', xTickInterval, xLabelFormat },
      style: { numberFormat: 'currency' },
      data: points.map((point) => ({ date: point.date, value: point.valueMinor })),
    },
  }, { contextAction: false });
  return sec;
}

function renderCredit() {
  state.section = 'credit';
  activeCreditUpload = null;
  renderSidebar();
  const view = $('#view');
  view.replaceChildren(topbar('Credit Reports', 'Imported from AnnualCreditReport', { action: pageActionButton('Manage reports', 'manageCreditReports'), hideDateRange: true }));
  view.appendChild(renderSubnav(creditTabs, state.creditTab, (tab) => {
    state.creditTab = tab;
    renderCredit();
  }));

  if (state.creditTab === 'reports') renderCreditReportsTab(view);
  else renderLatestCreditReportOverview(view);

  $('#manageCreditReports').addEventListener('click', openCreditManageModal);
}

function formatReportDate(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function reportLabel(report = {}) {
  return `${report.bureau || 'Unknown bureau'} report`;
}

function bytesLabel(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '-';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function reportDateTime(report) {
  const value = report?.reportDate || report?.createdAt || '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function reportsByReportDate(reports) {
  return [...(reports || [])].sort((a, b) => reportDateTime(b) - reportDateTime(a));
}

function oldestAccountAge(accounts) {
  const dates = accounts
    .map((account) => account.dateOpened)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (!dates.length) return '-';
  const now = new Date();
  let months = (now.getFullYear() - dates[0].getFullYear()) * 12 + (now.getMonth() - dates[0].getMonth());
  if (now.getDate() < dates[0].getDate()) months -= 1;
  if (months < 0) return '-';
  return `${Math.floor(months / 12)} yrs ${months % 12} mos`;
}

function latestCreditMetrics() {
  const latest = state.credit.latest || {};
  const accounts = state.credit.accounts || [];
  const hardInquiries = (state.credit.inquiries || []).filter((item) => item.type === 'hard').length;
  const latePayments = accounts.filter((account) => Number(account.pastDueMinor || 0) > 0 || /late|past due|delinquent/i.test(account.status || '')).length;
  return [
    ['Open accounts', latest.openAccounts ?? accounts.filter((account) => account.isOpen).length],
    ['Hard inquiries', latest.inquiries ?? hardInquiries],
    ['Collections', latest.collections ?? accounts.filter((account) => /collection/i.test(account.status || '')).length],
    ['Late payments', latePayments],
    ['Public records', latest.publicRecords ?? 0],
    ['Oldest account age', oldestAccountAge(accounts)],
  ];
}

// A subtle note when the LLM verify/fallback pass recovered rows the deterministic parse missed.
function aiReviewNote(report) {
  const review = report?.raw?.aiReview;
  const added = review ? (Number(review.addedAccounts) || 0) + (Number(review.addedInquiries) || 0) : 0;
  if (!added) return '';
  return ` · <span class="pill" title="AI recovered items the deterministic parser missed">AI-reviewed · +${added}</span>`;
}

function renderLatestCreditReportOverview(view) {
  const latest = state.credit.latest;
  if (!latest) {
    const emptySec = el('div', 'sec creditlatest');
    emptySec.innerHTML = '<div class="sechdr"><h3>Latest report overview</h3><span class="pill">Local only</span></div>';
    emptySec.appendChild(empty('Upload a text-searchable Equifax, Experian, TransUnion, or AnnualCreditReport PDF to see deterministic report facts here.'));
    view.appendChild(emptySec);
    return;
  }

  const overview = el('div', 'sec creditlatest');
  overview.innerHTML = `
    <div class="creditreporthead">
      <div>
        <div class="kicker">Latest uploaded report</div>
        <div class="creditreporttitle">${esc(reportLabel(latest))}</div>
        <div class="creditreportmeta">${esc(latest.filename)} · Uploaded ${esc(formatReportDate(latest.createdAt))}${latest.reportDate ? ` · Report date ${esc(formatReportDate(latest.reportDate))}` : ''}${aiReviewNote(latest)}</div>
      </div>
      <span class="status ${state.credit.suggestions.length ? 'warn' : 'good'}">${state.credit.suggestions.length ? `${state.credit.suggestions.length} review flag${state.credit.suggestions.length === 1 ? '' : 's'}` : 'No obvious flags'}</span>
    </div>`;
  const metrics = el('div', 'creditmetricgrid');
  for (const [label, value] of latestCreditMetrics()) {
    const cell = el('div', 'creditmetric');
    cell.innerHTML = `<div class="lab">${esc(label)}</div><div class="value num">${esc(value)}</div>`;
    metrics.appendChild(cell);
  }
  overview.appendChild(metrics);
  view.appendChild(overview);

  renderCreditAiInsights(view);
  renderCreditOpenAccounts(view);
  renderCreditInquiries(view);
}

function accountBalanceSummary(account) {
  const parts = [];
  if (account.balanceMinor !== null && account.balanceMinor !== undefined) parts.push(`Balance ${money(account.balanceMinor)}`);
  if (account.creditLimitMinor !== null && account.creditLimitMinor !== undefined) parts.push(`Limit ${money(account.creditLimitMinor)}`);
  if (Number(account.creditLimitMinor || 0) > 0 && account.balanceMinor !== null && account.balanceMinor !== undefined) {
    const utilization = Math.round((Math.max(0, Number(account.balanceMinor || 0)) / Number(account.creditLimitMinor)) * 1000) / 10;
    parts.push(`Utilization ${utilization}%`);
  }
  if (Number(account.pastDueMinor || 0) > 0) parts.push(`Past due ${money(account.pastDueMinor)}`);
  return parts.join(' · ') || account.accountType || 'Account details unavailable';
}

function renderMiniReportList(rows, emptyText, limit = 5) {
  const block = el('div', 'reportdetailblock');
  if (!rows.length) {
    const emptyRow = el('div', 'reportminirow emptymini');
    emptyRow.textContent = emptyText;
    block.appendChild(emptyRow);
    return block;
  }
  for (const row of rows.slice(0, limit)) {
    const item = el('div', `reportminirow ${row.level || ''}`);
    const text = el('div', 'reportminitext');
    text.innerHTML = `<div class="nm">${esc(row.title)}</div><div class="sub">${esc(row.detail)}</div>`;
    item.appendChild(text);
    if (row.context) {
      const { title, columns, values } = row.context;
      const id = stableItemId('item', [title, ...values]);
      const button = chatContextButton('', 'Add this item to chat context');
      setContextButtonState(button, id);
      button.addEventListener('click', () => addItemContext(id, title, columns, values, 'credit'));
      item.appendChild(button);
    }
    block.appendChild(item);
  }
  if (rows.length > limit) {
    const more = el('div', 'reportminirow moremini');
    more.textContent = `+${rows.length - limit} more`;
    block.appendChild(more);
  }
  return block;
}

// Attach a whole credit list (open accounts / inquiries) to chat context as a table,
// mirroring the whole-table button Banking/Brokerage tables get from renderDataTable.
function creditListContextButton(id, title, columns, valueRows) {
  const button = chatContextButton('Chat', 'Add this list to chat context');
  setContextButtonState(button, id);
  button.addEventListener('click', () => addTableContext(id, title, columns, valueRows, valueRows.length));
  return button;
}

function renderCreditOpenAccounts(view) {
  const accounts = state.credit.accounts || [];
  const columns = ['Creditor', 'Summary', 'Flag'];
  const openAccounts = accounts
    .filter((account) => account.isOpen)
    .map((account) => {
      const title = `${account.creditor}${account.accountMask ? ` ${account.accountMask}` : ''}`;
      const detail = accountBalanceSummary(account);
      const flagged = Number(account.pastDueMinor || 0) > 0 || account.isNegative;
      return {
        title,
        detail,
        level: flagged ? 'medium' : '',
        context: { title, columns, values: [title, detail, flagged ? 'Needs review' : 'OK'] },
      };
    });
  const section = el('div', 'sec creditdetails');
  section.innerHTML = '<div class="sechdr"><h3>Open accounts</h3><span class="pill">Latest report</span></div>';
  if (openAccounts.length) {
    section.querySelector('.sechdr').appendChild(
      creditListContextButton('table:credit-open-accounts', 'Credit open accounts', columns, openAccounts.map((row) => row.context.values)),
    );
  }
  section.appendChild(renderMiniReportList(openAccounts, 'No open accounts parsed.', 8));
  view.appendChild(section);
}

function renderCreditInquiries(view) {
  const inquiries = state.credit.inquiries || [];
  const columns = ['Company', 'Type', 'Date'];
  const rows = inquiries
    .map((inquiry) => {
      const title = inquiry.company || 'Unknown company';
      const type = inquiry.type === 'hard' ? 'Hard' : 'Soft';
      const date = inquiry.inquiryDate ? formatReportDate(inquiry.inquiryDate) : '';
      return {
        title,
        detail: `${type} inquiry${date ? ` · ${date}` : ''}`,
        level: inquiry.type === 'hard' ? 'medium' : '',
        context: { title, columns, values: [title, type, date] },
      };
    });
  const section = el('div', 'sec creditdetails');
  section.innerHTML = '<div class="sechdr"><h3>Inquiries</h3><span class="pill">Hard + soft</span></div>';
  if (rows.length) {
    section.querySelector('.sechdr').appendChild(
      creditListContextButton('table:credit-inquiries', 'Credit inquiries', columns, rows.map((row) => row.context.values)),
    );
  }
  section.appendChild(renderMiniReportList(rows, 'No inquiries parsed.', rows.length));
  view.appendChild(section);
}

function renderCreditAiInsights(view) {
  const latest = state.credit.latest;
  const reports = state.credit.reports || [];
  const suggestions = state.credit.suggestions || [];
  const previous = reports.find((report) => report.id !== latest?.id);
  const insights = [];
  if (suggestions.length) {
    const top = suggestions[0];
    insights.push({
      level: top.severity || 'medium',
      title: `${top.issue} may need review`,
      text: `${top.creditor}: ${top.why}`,
    });
  } else {
    insights.push({ level: 'low', title: 'No dispute candidates detected', text: 'The parser did not find obvious collections, past-due balances, or hard inquiry issues in the latest report.' });
  }
  if (previous) {
    const diff = Number(latest.openAccounts || 0) - Number(previous.openAccounts || 0);
    insights.push({
      level: diff === 0 ? 'low' : 'medium',
      title: previous.bureau === latest.bureau ? 'Compared with the previous upload' : 'Compared with another bureau upload',
      text: `${reportLabel(previous)} was uploaded ${formatReportDate(previous.createdAt)}. Open accounts changed by ${diff > 0 ? '+' : ''}${diff}; hard inquiries are ${latest.inquiries ?? 0} on the latest report versus ${previous.inquiries ?? 0}.`,
    });
  } else {
    insights.push({ level: 'low', title: 'Only one report is uploaded', text: 'Add another bureau report when available to let AI look for bureau-to-bureau differences.' });
  }
  if ((latest.collections || 0) > 0 || (latest.publicRecords || 0) > 0) {
    insights.push({ level: 'high', title: 'Derogatory information present', text: 'Collections or public records can be worth checking against your own records before taking action.' });
  }

  const sec = el('div', 'sec creditinsights');
  sec.innerHTML = '<div class="sechdr"><h3>AI insights</h3><span class="pill">Assistant layer</span></div>';
  for (const insight of insights) {
    const row = el('div', `insightrow ${insight.level}`);
    row.innerHTML = `<div><div class="nm">${esc(insight.title)}</div><div class="sub">${esc(insight.text)}</div></div>`;
    sec.appendChild(row);
  }
  view.appendChild(sec);
}

function renderCreditReportsTab(view) {
  const reports = reportsByReportDate(state.credit.reports);
  const sec = el('div', 'sec creditreports');
  sec.innerHTML = '<div class="sechdr"><h3>Uploaded reports</h3><span class="pill">History</span></div>';
  if (!reports.length) {
    sec.appendChild(empty('No uploaded credit report PDFs yet.'));
    view.appendChild(sec);
    return;
  }
  const list = el('div', 'reportlist');
  for (const report of reports) {
    const row = el('div', 'reportrow');
    row.innerHTML = `
      <div>
        <div class="nm">${esc(reportLabel(report))}</div>
        <div class="sub">${esc(report.filename)} · Report date ${esc(formatReportDate(report.reportDate))} · Uploaded ${esc(formatReportDate(report.createdAt))} · ${esc(bytesLabel(report.bytes))}</div>
      </div>
      <div class="reportfacts">
        <span class="pill">${esc(report.openAccounts ?? 0)} open</span>
        <span class="pill">${esc(report.inquiries ?? 0)} hard inquiries</span>
      </div>`;
    const actions = el('div', 'row');
    const structured = el('button', 'ghost');
    structured.type = 'button';
    structured.textContent = 'View parsed data';
    structured.addEventListener('click', () => openReportStructuredModal(report));
    actions.appendChild(structured);
    row.appendChild(actions);
    list.appendChild(row);
  }
  sec.appendChild(list);
  view.appendChild(sec);
}

function createCreditUploadForm(panel) {
  const form = el('form', 'formgrid creditform');
  form.innerHTML = '<label class="file-drop compact" data-testid="credit-dropzone">Drop PDF or choose file<small class="creditFileName">Experian, Equifax, TransUnion, or annual credit report PDF</small><input name="file" type="file" accept="application/pdf,.pdf" data-testid="credit-file-input"></label><span class="message creditMessage" data-testid="credit-message"></span><div class="uploadhistory creditUploadHistory"></div>';

  const fileInput = form.elements.file;
  const dropzone = form.querySelector('.file-drop');
  const fileName = form.querySelector('.creditFileName');
  const message = form.querySelector('.creditMessage');
  const history = form.querySelector('.creditUploadHistory');
  const uploadFile = async (file) => {
    message.textContent = `Parsing ${file.name}...`;
    message.classList.remove('error');
    dropzone.classList.add('busy');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      const result = await api('/v1/credit-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentBase64: btoa(binary) }),
      });
      const detail = `${result.report?.accounts ?? 0} credit lines, ${result.report?.inquiries ?? 0} hard inquiries, ${result.suggestions?.length ?? 0} review flags.`;
      message.textContent = `Processed ${file.name}.`;
      history.prepend(uploadResultRow(file.name, `${Math.round(result.bytes / 1024)} KB`, detail));
      await loadData();
      activeCreditUpload = null;
      closeModal();
      render();
      toast('Credit report PDF processed.');
    } catch (error) {
      message.textContent = error.message;
      message.classList.add('error');
      history.prepend(uploadResultRow(file.name, 'Failed', error.message, true));
    } finally {
      dropzone.classList.remove('busy', 'dragging');
      fileInput.value = '';
    }
  };
  activeCreditUpload = uploadFile;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileName.textContent = file?.name || 'Experian, Equifax, TransUnion, or annual credit report PDF';
    if (file) uploadFile(file);
  });
  for (const eventName of ['dragenter', 'dragover']) {
    panel.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    panel.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (eventName === 'dragleave' && panel.contains(event.relatedTarget)) return;
      dropzone.classList.remove('dragging');
    });
  }
  panel.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    fileName.textContent = file.name;
    uploadFile(file);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });
  return form;
}

function openCreditManageModal() {
  const reports = reportsByReportDate(state.credit.reports);
  const panel = el('div');
  panel.innerHTML = `<div class="sechdr"><h3>Manage reports</h3><button class="ghost" type="button" id="closeModal">Close</button></div>
    <p class="cardsub">Upload a new bureau PDF or remove reports you no longer want Finora to keep.</p>
    <div class="modalblock">
      <div class="kicker">Upload new report</div>
      <p class="cardsub">Download your free report from <a href="https://www.annualcreditreport.com/" target="_blank" rel="noreferrer">annualcreditreport.com</a>, then upload the text-searchable PDF here.</p>
    </div>`;
  panel.querySelector('.modalblock').appendChild(createCreditUploadForm(panel));
  const historyHeader = el('div', 'modalblock');
  historyHeader.innerHTML = '<div class="kicker">Uploaded reports</div>';
  const list = el('div', 'reportlist');
  if (!reports.length) {
    list.appendChild(empty('No uploaded reports yet.'));
  } else {
    for (const report of reports) {
      const row = el('div', 'reportrow');
      row.innerHTML = `<div><div class="nm">${esc(reportLabel(report))}</div><div class="sub">${esc(report.filename)} · Uploaded ${esc(formatReportDate(report.createdAt))}</div></div>`;
      const actions = el('div', 'row');
      const viewButton = el('button', 'ghost');
      viewButton.type = 'button';
      viewButton.textContent = 'View parsed data';
      viewButton.addEventListener('click', () => openReportStructuredModal(report));
      const deleteButton = el('button', 'ghost danger');
      deleteButton.type = 'button';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', async () => {
        deleteButton.disabled = true;
        try {
          state.credit = await api(`/v1/credit-reports/${encodeURIComponent(report.id)}`, { method: 'DELETE' });
          toast('Credit report deleted.');
          closeModal();
          renderCredit();
        } catch (error) {
          deleteButton.disabled = false;
          toast(error.message);
        }
      });
      actions.append(viewButton, deleteButton);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }
  historyHeader.appendChild(list);
  panel.appendChild(historyHeader);
  modal(panel);
  $('#closeModal').addEventListener('click', closeModal);
}

function openReportStructuredModal(report) {
  const raw = report.raw || {};
  const panel = el('div');
  panel.innerHTML = `<div class="sechdr"><h3>${esc(reportLabel(report))}</h3><button class="ghost" type="button" id="closeModal">Close</button></div>
    <div class="statusgrid">
      <div class="statuscell"><div class="lab">Bureau</div><div class="value">${esc(report.bureau || 'Unknown')}</div></div>
      <div class="statuscell"><div class="lab">Report date</div><div class="value">${esc(formatReportDate(report.reportDate))}</div></div>
      <div class="statuscell"><div class="lab">Uploaded</div><div class="value">${esc(formatReportDate(report.createdAt))}</div></div>
      <div class="statuscell"><div class="lab">File</div><div class="value">${esc(bytesLabel(report.bytes))}</div></div>
    </div>`;
  const accounts = asStructuredRows(raw.accounts);
  const inquiries = asStructuredRows(raw.inquiries);
  const suggestions = asStructuredRows(raw.suggestions);
  panel.appendChild(structuredPreview('Accounts', accounts));
  panel.appendChild(structuredPreview('Inquiries', inquiries));
  panel.appendChild(structuredPreview('Dispute candidates', suggestions));
  modal(panel);
  $('#closeModal').addEventListener('click', closeModal);
}

function asStructuredRows(value) {
  return Array.isArray(value) ? value : [];
}

function structuredPreview(title, rows) {
  const sec = el('div', 'structuredblock');
  sec.innerHTML = `<div class="sechdr"><h3>${esc(title)}</h3><span class="pill">${rows.length}</span></div>`;
  if (!rows.length) {
    sec.appendChild(empty(`No ${title.toLowerCase()} parsed for this report.`));
    return sec;
  }
  const keys = Object.keys(rows[0]).slice(0, 5);
  sec.appendChild(renderDataTable(keys.map(chartLabel), rows.map((row) => keys.map((key) => esc(row[key] ?? '-')))));
  return sec;
}

function uploadResultRow(filename, meta, detail, failed = false) {
  const row = el('div', `uploadrow${failed ? ' failed' : ''}`);
  row.innerHTML = `<div><div class="nm">${esc(filename)}</div><div class="sub">${esc(detail)}</div></div><span class="pill">${esc(meta)}</span>`;
  return row;
}

function visibleDashboard(dashboard) {
  const label = `${dashboard.id || ''} ${dashboard.publicId || ''} ${dashboard.name || ''}`;
  return !/\bsmoke\b/i.test(label);
}

function renderDashboards() {
  const view = $('#view');
  const createButton = pageActionButton('Create chart', 'openChartCreator');
  view.replaceChildren(topbar('Dashboards', 'Saved views', { hideDateRange: true, action: createButton }));
  $('#openChartCreator').addEventListener('click', () => openChartModal());
  const customArtifacts = customDashboardArtifacts();
  const hiddenArtifacts = hiddenDashboardArtifacts();
  const savedDashboards = state.dashboards.filter(visibleDashboard);
  const dashboards = savedDashboards.length
    ? savedDashboards.map((dashboard, index) => index === 0 ? {
        ...dashboard,
        artifacts: [...customArtifacts, ...(dashboard.artifacts || [])],
        layout: [
          ...customArtifacts.map((artifact) => ({ chartId: artifact.publicId, w: 6, h: 4 })),
          ...(Array.isArray(dashboard.layout) ? dashboard.layout : []),
        ],
      } : dashboard)
    : [{
        id: 'local-default-dashboard',
        name: 'Local dashboard',
        updatedAt: isoDate(today),
        layout: [...customArtifacts, ...defaultDashboardArtifacts()].map((artifact) => ({ chartId: artifact.publicId, w: 6, h: 4 })),
        artifacts: [...customArtifacts, ...defaultDashboardArtifacts()],
      }];
  for (const dashboard of dashboards) {
    const sec = el('div', 'sec');
    const visibleArtifacts = (dashboard.artifacts || []).filter((artifact) => !hiddenArtifacts.has(artifact.publicId || artifact.id));
    const artifactCount = visibleArtifacts.length;
    const isLocalDashboard = dashboard.id === 'local-default-dashboard';
    if (!isLocalDashboard) {
      sec.innerHTML = `<div class="sechdr"><h3>${esc(dashboard.name)}</h3><span class="pill">${artifactCount} artifact${artifactCount === 1 ? '' : 's'}</span></div>`;
    }
    const artifacts = visibleArtifacts;
    const byId = new Map();
    for (const artifact of artifacts) {
      byId.set(artifact.id, artifact);
      if (artifact.publicId) byId.set(artifact.publicId, artifact);
    }
    const layoutItems = Array.isArray(dashboard.layout) && dashboard.layout.length
      ? dashboard.layout
      : artifacts.map((artifact) => ({ chartId: artifact.publicId || artifact.id, w: 6, h: 4 }));
    const grid = el('div', 'dashgrid');
    for (const item of layoutItems) {
      const saved = byId.get(item.chartId) || byId.get(item.id) || byId.get(item.chart_id);
      if (!saved) continue;
      const slot = el('div', 'dashslot sec');
      slot.dataset.testid = 'chart-card';
      slot.style.margin = '0';
      const span = Number(item.w || item.width || 6);
      slot.style.gridColumn = `span ${Math.min(12, Math.max(3, span))}`;
      const actions = el('div', 'dashactions');
      const artifact = normalizeArtifact(saved);
      const rows = resolveArtifactRows(artifact);
      const chat = dashboardActionButton('chat', 'Add chart to chat context');
      setContextButtonState(chat, `chart:${saved.publicId || saved.id || artifact.title || 'chart'}`);
      chat.addEventListener('click', () => addChartContext(saved, rows, artifact));
      actions.appendChild(chat);
      const edit = dashboardActionButton('edit', 'Chart actions');
      edit.addEventListener('click', (event) => {
        event.stopPropagation();
        closeDashboardMenus();
        openChartModal(editableDashboardArtifact(saved));
      });
      actions.appendChild(edit);
      slot.appendChild(actions);
      const host = el('div');
      slot.appendChild(host);
      grid.appendChild(slot);
      renderArtifactChart(host, saved, { contextAction: false });
    }
    if (!grid.children.length) grid.appendChild(empty('No dashboard widgets matched the saved artifacts.'));
    sec.appendChild(grid);
    view.appendChild(sec);
  }
}

function openChartModal(existingArtifact = null) {
  const panel = el('div', 'chartcreator');
  panel.dataset.modalClass = 'chartmodal-shell';
  const editing = Boolean(existingArtifact);
  const existingPrompt = existingArtifact?.artifact?.description || existingArtifact?.name || '';
  panel.innerHTML = `<div class="sechdr"><div><h3>${editing ? 'Edit chart' : 'Create chart'}</h3><p class="cardsub">Describe the chart you want, preview it, then ${editing ? 'save the update' : 'save it to the dashboard'}.</p></div><button class="ghost" type="button" id="closeModal">Close</button></div>`;
  const form = el('form', 'chartbuilder');
  form.innerHTML = `<div class="chartcomposer">
      <label class="chartprompt">Chart prompt<textarea name="prompt" rows="5" placeholder="Example: monthly cash flow line chart, spending by category donut, top merchants bar chart" required>${esc(existingPrompt)}</textarea></label>
      <div class="promptchips" aria-label="Chart prompt examples"${editing ? ' hidden' : ''}>
        <button type="button" class="promptchip">Monthly cash flow line chart</button>
        <button type="button" class="promptchip">Spending by category donut</button>
        <button type="button" class="promptchip">Top merchants bar chart</button>
        <button type="button" class="promptchip">Credit card spending by week</button>
      </div>
      <div class="chartcomposer-actions">
        <button class="primary" type="button" id="previewChart">Preview chart</button>
        <button class="ghost" type="submit" id="saveChart"${editing ? '' : ' hidden disabled'}>${editing ? 'Save changes' : 'Save to dashboard'}</button>
        ${editing ? `<button class="ghost danger" type="button" id="deleteChart">${existingArtifact?.replacesArtifactId ? 'Delete widget' : 'Delete chart'}</button>` : ''}
        <span class="message"></span>
      </div>
    </div>
    <aside class="chartpreviewpane" aria-label="Chart preview">
      <div class="chartpreviewhead"><div><div class="nm">Preview</div><div class="sub">Generated from the current prompt</div></div><span class="pill" id="chartPreviewState">Empty</span></div>
      <div class="chartpreview empty" id="chartPreview"><div class="chartpreviewempty">Preview appears here after you generate a chart.</div></div>
    </aside>`;
  panel.appendChild(form);
  modal(panel);
  $('#closeModal').addEventListener('click', closeModal);
  $('#deleteChart')?.addEventListener('click', () => removeEditableDashboardArtifact(existingArtifact));
  let previewArtifact = existingArtifact;
  if (editing && existingArtifact) {
    const host = el('div');
    $('#chartPreview').classList.remove('empty');
    $('#chartPreview').replaceChildren(host);
    renderArtifactChart(host, existingArtifact);
    $('#chartPreviewState').textContent = 'Ready';
  }
  for (const chip of panel.querySelectorAll('.promptchip')) {
    chip.addEventListener('click', () => {
      form.elements.prompt.value = chip.textContent;
      form.elements.prompt.focus();
      previewArtifact = null;
      $('#saveChart').hidden = true;
      $('#saveChart').disabled = true;
      $('#chartPreviewState').textContent = 'Empty';
      $('#chartPreview').classList.add('empty');
      $('#chartPreview').replaceChildren(el('div', 'chartpreviewempty'));
      $('#chartPreview').firstChild.textContent = 'Preview appears here after you generate a chart.';
    });
  }
  form.elements.prompt.addEventListener('input', () => {
    previewArtifact = null;
    $('#saveChart').hidden = true;
    $('#saveChart').disabled = true;
    $('#chartPreviewState').textContent = 'Empty';
    $('#chartPreview').classList.add('empty');
    const placeholder = el('div', 'chartpreviewempty');
    placeholder.textContent = 'Preview appears here after you generate a chart.';
    $('#chartPreview').replaceChildren(placeholder);
  });
  $('#previewChart').addEventListener('click', () => {
    const prompt = String(new FormData(form).get('prompt') || '').trim();
    if (!prompt) return;
    previewArtifact = customChartFromPrompt(prompt, editing ? existingArtifact : null);
    const host = el('div');
    $('#chartPreview').classList.remove('empty');
    $('#chartPreview').replaceChildren(host);
    renderArtifactChart(host, previewArtifact);
    $('#chartPreviewState').textContent = 'Ready';
    $('#saveChart').hidden = false;
    $('#saveChart').disabled = false;
    form.querySelector('.message').textContent = '';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!previewArtifact || $('#saveChart').disabled) return;
    if (editing) updateCustomDashboardArtifact(existingArtifact.id || existingArtifact.publicId, previewArtifact);
    else saveCustomDashboardArtifact(previewArtifact);
    if (previewArtifact.replacesArtifactId) hideDashboardArtifact(previewArtifact.replacesArtifactId);
    closeModal();
    toast(editing ? 'Chart updated.' : 'Chart saved.');
    renderDashboards();
  });
}

function renderSettings() {
  const view = $('#view');
  if (state.settingsTab === 'banks' || state.settingsTab === 'brokerage') state.settingsTab = 'accounts';
  const action = state.settingsTab === 'insights' ? el('button', 'primary') : null;
  if (action) {
    action.type = 'button';
    action.id = 'newRuleTopbar';
    action.textContent = 'Create rule';
  }
  view.replaceChildren(topbar('Settings', 'Local runtime', { hideDateRange: true, action }));
  if (action) action.addEventListener('click', () => openRuleModal());
  const nav = el('div', 'subnav');
  for (const [id, label] of settingsTabs) {
    const tab = el('div', `subtab${state.settingsTab === id ? ' active' : ''}`);
    tab.dataset.testid = `subtab-${id}`;
    tab.textContent = label;
    tab.addEventListener('click', () => {
      state.settingsTab = id;
      renderSettings();
    });
    nav.appendChild(tab);
  }
  view.appendChild(nav);

  if (state.settingsTab === 'models') return renderSettingsModels(view);
  if (state.settingsTab === 'accounts') return renderSettingsAccounts(view);
  if (state.settingsTab === 'delivery') return renderSettingsDelivery(view);
  return renderSettingsInsights(view);
}

function settingRow(key, label, type = 'text', disabled = false) {
  const current = setting(key);
  const placeholder = disabled ? 'Not required' : current.set ? current.preview : 'Not set';
  return `<label>${esc(label)}<input name="${esc(key)}" type="${esc(type)}" placeholder="${esc(placeholder)}" autocomplete="off"${disabled ? ' disabled' : ''}></label>`;
}

async function saveSettings(entries, toastMessage = 'Settings saved.') {
  const body = {};
  for (const [key, value] of Object.entries(entries)) {
    if (String(value).trim()) body[key] = String(value).trim();
  }
  const result = await api('/v1/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await loadData();
  toast(toastMessage);
  return result;
}

function settingsForm(title, subtitle, rows) {
  const sec = el('div', 'sec');
  sec.innerHTML = `<div class="sechdr"><h3>${esc(title)}</h3></div><div class="cardsub">${subtitle}</div>`;
  const form = el('form', 'formgrid settingsform');
  form.innerHTML = rows.join('') + '<div class="row"><button class="primary" type="submit">Save</button><span class="message"></span></div>';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const msg = form.querySelector('.message');
    try {
      const result = await saveSettings(data);
      msg.textContent = `Saved ${result.saved}.`;
      renderSettings();
    } catch (error) {
      msg.textContent = error.message;
      msg.classList.add('error');
    }
  });
  sec.appendChild(form);
  return sec;
}

function providerCredentialGuide() {
  const guide = el('div', 'settingsguide');
  guide.innerHTML = '<div class="nm">How to get Plaid credentials</div><ol><li>Open the Plaid Dashboard and choose the app/environment you want Finora to use.</li><li>Go to Team Settings or API keys, then copy the Client ID.</li><li>Copy the Secret for the same environment. Use sandbox credentials while testing.</li><li>Save both values here before opening Plaid Link.</li></ol>';
  return guide;
}

function formatModelSize(bytes) {
  const gb = Number(bytes || 0) / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(Number(bytes || 0) / 1_000_000)} MB`;
}

function renderSettingsModels(view) {
  const effective = state.llm?.effective || {};
  // The dropdown selection can be STAGED before it is saved (built-in only), so the
  // user can download + test the model first. Every other provider commits on change.
  const selected = state.pendingLlmProvider || effective.provider;
  if (selected === 'builtin') renderBuiltinModelSettings(view, effective);
  else renderApiModelSettings(view, effective);
}

// The API / custom-provider path: key, base URL, and model fields saved via the
// form. Switching provider commits immediately (so "Test model", which tests the
// SAVED config, exercises the selection); switching to the built-in model instead
// stages it for the download → test → save flow.
function renderApiModelSettings(view, effective) {
  const providers = state.llm?.providers || [];
  const providerOptions = providers.map((provider) =>
    `<option value="${esc(provider.id)}"${provider.id === effective.provider ? ' selected' : ''}>${esc(provider.label)}</option>`
  ).join('');
  const rows = [
    `<label>Provider<select name="LLM_PROVIDER">${providerOptions}</select></label>`,
    settingRow('LLM_API_KEY', 'API key', 'password'),
    settingRow('LLM_BASE_URL', 'Base URL'),
    settingRow('LLM_MODEL', 'Extraction model'),
    settingRow('LLM_CHAT_MODEL', 'Chat model'),
  ];
  const subtitle = `Web chat and Telegram use the same configured model. Current route: ${esc(effective.label || 'not configured')} / ${esc(effective.chatModel || 'no chat model')}.`;
  const formSection = settingsForm('Language model', subtitle, rows);
  const actions = formSection.querySelector('.row');
  const test = el('button', 'ghost');
  test.type = 'button';
  test.textContent = 'Test model';
  const status = el('span', 'message');
  const providerSelect = formSection.querySelector('select[name="LLM_PROVIDER"]');
  providerSelect.addEventListener('change', async () => {
    const value = providerSelect.value;
    if (value === effective.provider) return;
    if (value === 'builtin') {
      // Stage the built-in model without saving; its own card gates Save on a test.
      state.pendingLlmProvider = 'builtin';
      renderSettings();
      return;
    }
    providerSelect.disabled = true;
    status.textContent = 'Switching…';
    status.classList.remove('error');
    try {
      state.pendingLlmProvider = null;
      await saveSettings({ LLM_PROVIDER: value }, 'Provider updated.');
      renderSettings();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
      providerSelect.disabled = false;
    }
  });
  test.addEventListener('click', async () => {
    test.disabled = true;
    status.textContent = 'Testing…';
    status.classList.remove('error');
    try {
      const result = await api('/v1/llm/test', { method: 'POST' });
      status.textContent = `Connected: ${result.provider} / ${result.model}`;
      toast('Model connection OK.');
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
    } finally {
      test.disabled = false;
    }
  });
  actions.append(test, status);
  view.appendChild(formSection);
}

// The built-in local-model path. It mirrors the API-provider form (Provider,
// API key, Base URL, Model) so the layout is consistent — but API key and Base
// URL are disabled (the local model needs neither), and Model is a dropdown of
// the downloadable built-in models. Below the form sits the download flow: a
// Download button, then Test + Save which both unlock once the selected model is
// downloaded. Selecting built-in only STAGES it — nothing is persisted until
// Save. Switching to another provider commits immediately.
function renderBuiltinModelSettings(view, effective) {
  const providers = state.llm?.providers || [];
  const models = state.llm?.builtinModels || [];
  const builtinActive = effective.provider === 'builtin';
  const sec = el('div', 'sec');
  view.appendChild(sec);

  const defaultId = models[0]?.modelId || effective.model;
  // Selection can be staged before Save (built-in only). Fall back to the saved
  // model when already active, otherwise the first built-in model.
  let selectedId = state.pendingBuiltinModel || (builtinActive ? effective.model : null) || defaultId;
  if (!models.some((m) => m.modelId === selectedId)) selectedId = defaultId;

  const providerOptions = providers.map((provider) =>
    `<option value="${esc(provider.id)}"${provider.id === 'builtin' ? ' selected' : ''}>${esc(provider.label)}</option>`
  ).join('');
  const modelOptions = models.map((m) =>
    `<option value="${esc(m.modelId)}"${m.modelId === selectedId ? ' selected' : ''}>${esc(m.label)} — ${esc(formatModelSize(m.approxSizeBytes))}${m.present ? '' : ' (not downloaded)'}</option>`
  ).join('');
  const subtitle = builtinActive
    ? 'Finora is using its built-in local model — no API key required. It runs fully on your computer.'
    : 'Finora’s built-in local model runs fully on your computer — no API key. Pick a model, download it once, then Save to switch.';
  sec.innerHTML = `
    <div class="sechdr"><h3>Language model</h3></div>
    <div class="cardsub">${subtitle}</div>
    <form class="formgrid settingsform">
      <label>Provider<select name="LLM_PROVIDER">${providerOptions}</select></label>
      ${settingRow('LLM_API_KEY', 'API key', 'password', true)}
      ${settingRow('LLM_BASE_URL', 'Base URL', 'text', true)}
      <label>Model<select name="LLM_MODEL">${modelOptions}</select></label>
    </form>
    <div data-status style="margin-top:10px"></div>
    <div class="row" style="gap:8px;margin-top:10px" data-actions></div>
    <div class="row" style="align-items:center;gap:8px;margin-top:8px"><span class="message" data-msg></span></div>`;

  const providerSelect = sec.querySelector('select[name="LLM_PROVIDER"]');
  const modelSelect = sec.querySelector('select[name="LLM_MODEL"]');
  const statusBox = sec.querySelector('[data-status]');
  const actionRow = sec.querySelector('[data-actions]');
  const msg = sec.querySelector('[data-msg]');

  // Append the selected model id so every model route acts on the staged choice.
  const withModel = (path) => `${path}${path.includes('?') ? '&' : '?'}modelId=${encodeURIComponent(selectedId)}`;

  providerSelect.addEventListener('change', async () => {
    const value = providerSelect.value;
    if (value === 'builtin') return;
    providerSelect.disabled = true;
    try {
      state.pendingLlmProvider = null;
      state.pendingBuiltinModel = null;
      await saveSettings({ LLM_PROVIDER: value }, 'Provider updated.');
      renderSettings();
    } catch (error) {
      msg.textContent = error.message;
      msg.classList.add('error');
      providerSelect.disabled = false;
    }
  });

  modelSelect.addEventListener('change', () => {
    selectedId = modelSelect.value;
    state.pendingBuiltinModel = selectedId;
    msg.textContent = '';
    msg.classList.remove('error');
    // Fetch this model's fresh status, then render + resume polling if needed.
    void refresh();
  });

  const render = (model) => {
    statusBox.innerHTML = '';
    actionRow.innerHTML = '';
    if (!model) return;
    const download = model.download || {};
    const downloading = download.state === 'downloading';
    const ready = model.present || download.state === 'ready';
    const errored = download.state === 'error';
    const total = download.totalSize || model.approxSizeBytes || 0;
    const done = download.downloadedSize || 0;
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;

    let statusLine;
    if (!model.engineAvailable) statusLine = `<span class="message error">Local engine unavailable: ${esc(model.engineError || 'unsupported platform')}</span>`;
    else if (ready) statusLine = '<span class="message">Downloaded and ready — chat runs on your computer.</span>';
    else if (downloading) statusLine = `<span class="message">Downloading… ${percent}% (${formatModelSize(done)} / ${formatModelSize(total)})</span>`;
    else if (errored) statusLine = `<span class="message error">Download failed: ${esc(download.error || 'unknown error')}</span>`;
    else statusLine = `<span class="message">Not downloaded yet — about ${formatModelSize(total)} to download once.</span>`;
    const bar = downloading
      ? `<div style="height:8px;border-radius:4px;background:rgba(127,127,127,0.2);overflow:hidden;margin:10px 0"><div style="height:100%;width:${percent}%;background:var(--accent,#4f8cff);transition:width .3s"></div></div>`
      : '';
    statusBox.innerHTML = `<div class="cardsub"><code>${esc(model.label || 'Built-in model')}</code> — downloaded from a public model host to <code>~/.finora/models</code>. Your data never leaves your computer.</div>${bar}<div class="row" style="align-items:center;gap:8px;margin-top:8px">${statusLine}</div>`;

    if (!model.engineAvailable) return;

    if (downloading) {
      const cancel = el('button', 'ghost');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => act(withModel('/v1/llm/model/download'), 'DELETE', cancel));
      actionRow.append(cancel);
      return;
    }

    if (!ready) {
      const start = el('button', 'primary');
      start.type = 'button';
      start.textContent = errored ? 'Retry download' : `Download model (${formatModelSize(total)})`;
      start.addEventListener('click', () => act(withModel('/v1/llm/model/download'), 'POST', start));
      actionRow.append(start);
      return;
    }

    // Ready: Test + (unless this model is already the saved one) Save — both
    // clickable now that the download is complete. Plus Delete.
    const test = el('button', 'ghost');
    test.type = 'button';
    test.textContent = 'Test model';
    const showSave = !(builtinActive && selectedId === effective.model);
    let save = null;
    if (showSave) {
      save = el('button', 'primary');
      save.type = 'button';
      save.textContent = 'Save';
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          state.pendingLlmProvider = null;
          state.pendingBuiltinModel = null;
          await saveSettings(
            { LLM_PROVIDER: 'builtin', LLM_MODEL: selectedId, LLM_CHAT_MODEL: selectedId },
            'Built-in model saved.',
          );
          // Now that the new model is saved (its download succeeded), free disk by
          // deleting every other built-in model. They stay in the dropdown as
          // re-downloadable. Reload so their "(not downloaded)" state shows.
          await api(withModel('/v1/llm/model/prune'), { method: 'POST' });
          await loadData();
          renderSettings();
        } catch (error) {
          msg.textContent = error.message;
          msg.classList.add('error');
          save.disabled = false;
        }
      });
    }
    test.addEventListener('click', async () => {
      test.disabled = true;
      msg.textContent = 'Testing…';
      msg.classList.remove('error');
      try {
        const result = await api(withModel('/v1/llm/model/test'), { method: 'POST' });
        msg.textContent = `Connected: ${result.provider} / ${result.model}`;
        toast('Model connection OK.');
      } catch (error) {
        msg.textContent = error.message;
        msg.classList.add('error');
      } finally {
        test.disabled = false;
      }
    });
    const remove = el('button', 'ghost');
    remove.type = 'button';
    remove.textContent = 'Delete download';
    remove.addEventListener('click', () => {
      if (!confirm(`Delete the downloaded model (${formatModelSize(total)})? You can download it again later.`)) return;
      act(withModel('/v1/llm/model'), 'DELETE', remove);
    });
    // Order: Test, Delete download, then Save on the right (the primary commit action).
    actionRow.append(test, remove);
    if (save) actionRow.append(save);
  };

  const act = async (path, method, button) => {
    if (button) button.disabled = true;
    try {
      const model = await api(path, { method });
      render(model);
      poll();
    } catch (error) {
      toast(error.message);
      if (button) button.disabled = false;
    }
  };

  const refresh = async () => {
    try {
      const model = await api(withModel('/v1/llm/model'));
      render(model);
      if (model.download?.state === 'downloading') poll();
    } catch (error) {
      msg.textContent = error.message;
      msg.classList.add('error');
    }
  };

  const poll = () => {
    // Stop polling once the card leaves the DOM (user navigated away).
    if (!document.body.contains(sec)) return;
    setTimeout(async () => {
      if (!document.body.contains(sec)) return;
      try {
        const model = await api(withModel('/v1/llm/model'));
        render(model);
        if (model.download?.state === 'downloading') poll();
      } catch {
        poll();
      }
    }, 1000);
  };

  // Paint instantly from cached state, then reconcile with live status: a download
  // started earlier keeps running server-side even after navigating away, so on
  // return we re-fetch and resume the progress bar/polling instead of showing it as
  // if it were cancelled.
  const initial = models.find((m) => m.modelId === selectedId);
  render(initial);
  void refresh();
}

function renderSettingsAccounts(view) {
  const hasCredentials = settingIsSet('PLAID_CLIENT_ID') && settingIsSet('PLAID_SECRET');
  const form = settingsForm(
    'Plaid API settings',
    hasCredentials
      ? 'Plaid credentials are saved. Link, token exchange, banking sync, and brokerage investment sync are wired in this build.'
      : 'Save the app-level Plaid credentials used to create a Link token. Bank and brokerage login should happen only inside Plaid Link.',
    [
      settingRow('PLAID_CLIENT_ID', 'Plaid client ID'),
      settingRow('PLAID_SECRET', 'Plaid secret', 'password'),
    ],
  );
  form.appendChild(providerCredentialGuide());
  view.appendChild(form);
  const plaidAccounts = state.accounts.filter((account) => account.source === 'plaid');
  renderAccountManager(view, 'plaid', plaidAccounts);
}

function renderSettingsDelivery(view) {
  const sec = el('div', 'sec notificationpanel');
  sec.innerHTML = '<div class="sechdr"><h3>Insight delivery</h3></div><div class="cardsub">Choose where rule-triggered insights are delivered. The Insights feed always stays local; delivery channels are only for pushed items.</div>';
  const layout = el('div', 'notificationlayout');
  const picker = el('div', 'channelpicker');
  for (const [id, channel] of Object.entries(notificationChannels)) {
    const button = el('button', `channeloption${state.notificationChannel === id ? ' active' : ''}`);
    button.type = 'button';
    const connected = channel.statusKeys.every((key) => settingIsSet(key));
    button.innerHTML = `<span class="channelcopy"><span class="nm">${esc(channel.title)}</span><span class="sub">${esc(channel.summary)}</span></span><span class="status ${connected ? 'ok' : 'off'}">${connected ? 'Ready' : 'Setup'}</span>`;
    button.addEventListener('click', async () => {
      state.notificationChannel = id;
      await saveSettings({ NOTIFICATION_CHANNEL: id }, 'Channel selected.');
      renderSettings();
    });
    picker.appendChild(button);
  }
  layout.appendChild(picker);

  const selected = notificationChannels[state.notificationChannel] || notificationChannels.telegram;
  const detail = el('div', 'channeldetail');
  const ready = selected.statusKeys.every((key) => settingIsSet(key));
  detail.innerHTML = `<div class="sechdr"><h3>${esc(selected.title)} setup</h3><span class="status ${ready ? 'ok' : 'off'}">${ready ? 'Ready' : 'Needs setup'}</span></div><div class="cardsub">${esc(selected.note)}</div>`;
  const steps = el('div', 'steplist');
  selected.steps.forEach(([label, instruction], index) => {
    const row = el('div', 'steprow');
    row.innerHTML = `<span class="stepnum">${index + 1}</span><div><div class="nm">${esc(label)}</div><div class="sub">${esc(instruction)}</div></div>`;
    steps.appendChild(row);
  });
  const form = el('form', 'formgrid settingsform channelform');
  form.innerHTML = selected.rows.map(([key, label, type]) => settingRow(key, label, type)).join('')
    + '<div class="row"><button class="primary" type="submit">Save credentials</button><span class="message"></span></div>';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.NOTIFICATION_CHANNEL = state.notificationChannel;
    const msg = form.querySelector('.message');
    try {
      await saveSettings(data, 'Credentials saved.');
      msg.textContent = state.notificationChannel === 'telegram'
        ? 'Bot token saved. Send a Telegram message to the bot, then click Connect chat.'
        : 'Credentials saved.';
    } catch (error) {
      msg.textContent = error.message;
      msg.classList.add('error');
    }
  });
  detail.append(steps, form);
  if (state.notificationChannel === 'telegram') {
    const connect = el('div', 'connectbox');
    const chatTitle = settingValue('TELEGRAM_CHAT_TITLE', '');
    const chatId = settingValue('TELEGRAM_CHAT_ID', '');
    connect.innerHTML = `<div><div class="nm">Bound chat</div><div class="sub">${chatId ? esc(chatTitle || chatId) : 'No Telegram chat connected yet.'}</div></div><button class="primary" type="button" id="connectTelegram">Connect chat</button><span class="message" id="telegramConnectMessage"></span>`;
    connect.querySelector('#connectTelegram').addEventListener('click', async () => {
      const button = connect.querySelector('#connectTelegram');
      const message = connect.querySelector('#telegramConnectMessage');
      button.disabled = true;
      message.classList.remove('error');
      message.textContent = 'Checking latest bot message...';
      try {
        const result = await api('/v1/telegram/connect', { method: 'POST' });
        await loadData();
        message.textContent = `Connected ${result.chat.title}.`;
        toast('Telegram chat connected.');
        renderSettings();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });
    detail.appendChild(connect);
  }
  layout.appendChild(detail);
  sec.appendChild(layout);
  view.appendChild(sec);
}

// The answer surface: every still-unanswered user fact across all rules, so a
// single answer can unlock any rule that references that fact. Questions are treated
// as equally important — no ranking. Hidden entirely when nothing is outstanding.
function renderNeedsInput(view) {
  // Temporarily hidden from the UI (backend/questions machinery is untouched).
  return;
  const pending = state.factNeeds.pending || [];
  if (!pending.length) return;
  const sec = el('div', 'sec');
  sec.innerHTML = `<div class="sechdr"><h3>Needs your input</h3><span class="pill">${pending.length}</span></div>`
    + '<div class="cardsub">Some rules need details only you know. Answer these to turn them on.</div>';
  const box = el('div', 'needslist');
  for (const need of pending) box.appendChild(needInputRow(need));
  sec.appendChild(box);
  view.appendChild(sec);
}

function needInputRow(need) {
  const row = el('div', 'needrow');
  const numeric = need.expects === 'currency' || need.expects === 'percent' || need.expects === 'number';
  const type = need.expects === 'date' ? 'date' : 'text';
  const placeholder = need.expects === 'currency' ? 'e.g. 120000' : need.expects === 'percent' ? 'e.g. 6' : '';
  const form = el('form', 'needform');
  form.innerHTML = `<div class="needprompt">${esc(need.prompt)}</div>`
    + `<div class="needentry"><input name="value" type="${type}"${numeric ? ' inputmode="decimal"' : ''} placeholder="${esc(placeholder)}" autocomplete="off" required />`
    + '<button class="primary" type="submit">Save</button></div><span class="message"></span>';
  const message = form.querySelector('.message');
  const button = form.querySelector('button');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = form.elements.value.value.trim();
    if (!value) return;
    button.disabled = true;
    message.textContent = '';
    try {
      await api('/v1/facts/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: need.key, value }),
      });
      toast('Saved.');
      await loadData();
      renderSettings();
    } catch (error) {
      message.textContent = (error && error.message) || 'Could not save that value.';
      button.disabled = false;
    }
  });
  row.appendChild(form);
  return row;
}

function renderSettingsInsights(view) {
  renderNeedsInput(view);
  const sec = el('div', 'sec');
  sec.innerHTML = '<div class="sechdr"><h3>Rules</h3></div><div class="cardsub">Rules can run on events or on a schedule. Use the switch to pause delivery without changing the rule.</div>';
  const box = el('div', 'rulelist');
  // Rules come from the backend with a real (server-persisted) on/off switch, keyed
  // by kind. `active` is the switch. `source` drives the permission matrix: built-in
  // and downloaded rules can be toggled and rescheduled but not edited or deleted;
  // custom (source='user') rules can be edited (their SQL regenerated) and deleted.
  const rules = state.rules.map((rule) => {
    const meta = RULE_META[rule.kind] || {};
    const builtIn = rule.source !== 'user';
    return {
      ...rule,
      builtIn,
      title: builtIn ? (meta.title || prettyKind(rule.kind)) : (rule.sourceText || prettyKind(rule.kind)),
      description: builtIn ? (rule.sourceText || meta.detail || '') : '',
      enabled: rule.active,
      editable: true,
      toggle: async () => {
        await api('/v1/rules/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: rule.kind, enabled: !rule.active }),
        });
        await loadData();
        renderSettings();
      },
      remove: builtIn ? null : async () => {
        if (!confirm(`Delete this custom rule? This can't be undone.`)) return;
        await api('/v1/rules/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: rule.kind }),
        });
        await loadData();
        toast('Rule deleted.');
        renderSettings();
      },
    };
  });
  // Group by the rules taxonomy so every rule sits under one domain heading.
  const domainOf = (rule) => rule.domain || rule.category || 'cash-flow';
  const grouped = new Map(ruleDomains.map(([key]) => [key, []]));
  for (const rule of rules) {
    const key = grouped.has(domainOf(rule)) ? domainOf(rule) : 'cash-flow';
    grouped.get(key).push(rule);
  }
  for (const [key, label, blurb] of ruleDomains) {
    const group = grouped.get(key);
    if (!group.length) continue;
    const header = el('div', 'rulegroup');
    header.innerHTML = `<div class="rulegrouphdr"><h4>${esc(label)}</h4><span class="pill">${group.length}</span></div><div class="cardsub">${esc(blurb)}</div>`;
    box.appendChild(header);
    for (const rule of group) box.appendChild(ruleRow(rule));
  }
  sec.appendChild(box);
  view.appendChild(sec);

  renderRuleFeed(view);

  const muted = el('div', 'sec');
  muted.innerHTML = '<div class="sechdr"><h3>Muted insights</h3><span class="pill">' + state.insightMutes.length + '</span></div>';
  muted.appendChild(state.insightMutes.length ? transactionLikeTable(
    ['Mute', 'Expires', 'Created'],
    state.insightMutes.map((mute) => [
      esc(mute.label || mute.kind || mute.accountId || 'Mute'),
      esc(mute.expiresAt || 'Permanent'),
      esc(mute.createdAt),
    ]),
    { pageKey: 'settings-muted' },
  ) : empty('Nothing muted.'));
  view.appendChild(muted);
}

// Over-the-air rule updates: point Finora at a rules feed URL (a JSON file, e.g. a
// GitHub raw URL, or a local static server in dev). Checking adds any built-in
// rules this version doesn't have yet; rules already present are left untouched.
function renderRuleFeed(view) {
  const sec = el('div', 'sec');
  sec.innerHTML = '<div class="sechdr"><h3>Rule updates</h3></div>'
    + '<div class="cardsub">Point Finora at a rules feed URL — a JSON file (for example a GitHub raw link). Checking adds any new built-in rules; rules you already have are left as they are.</div>';
  const form = el('form', 'formgrid settingsform');
  form.innerHTML = settingRow('RULES_FEED_URL', 'Rules feed URL', 'url')
    + '<div class="row"><button class="primary" type="submit">Save URL</button>'
    + '<button class="ghost" type="button" id="syncRules">Check for updates</button>'
    + '<span class="message"></span></div>';
  const message = form.querySelector('.message');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await saveSettings(Object.fromEntries(new FormData(form)), 'Feed URL saved.');
      renderSettings();
    } catch (error) {
      message.textContent = error.message;
    }
  });
  form.querySelector('#syncRules').addEventListener('click', async (event) => {
    event.target.disabled = true;
    message.textContent = 'Checking…';
    try {
      const result = await api('/v1/rules/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      toast(ruleSyncMessage(result));
      await loadData();
      renderSettings();
    } catch (error) {
      message.textContent = error.message;
      event.target.disabled = false;
    }
  });
  sec.appendChild(form);
  view.appendChild(sec);
}

function ruleSyncMessage(result) {
  if (!result.skipped) {
    return result.applied === 0
      ? `Already up to date (feed v${result.version}).`
      : `Added ${result.applied} new rule${result.applied === 1 ? '' : 's'} (feed v${result.version}).`;
  }
  if (result.reason === 'no-feed-url') return 'Set and save a feed URL first.';
  if (result.reason === 'fetch-failed') return "Couldn't reach the feed URL — check it and try again.";
  return 'No rule feed is available.';
}

function ruleRow(rule) {
  const row = el('div', `rulerow${rule.enabled ? '' : ' muted'}`);
  const copy = el('div', 'rulecopy');
  copy.innerHTML = `<div class="nm">${esc(rule.title)}</div>${rule.description ? `<div class="sub">${esc(rule.description)}</div>` : ''}${ruleMetaTags(rule)}`;
  const actions = el('div', 'ruleactions');
  actions.appendChild(ruleToggle(rule));
  if (rule.editable) {
    const edit = el('button', 'ghost');
    edit.type = 'button';
    // Built-in: edit the schedule only. Custom: edit the content (regenerate SQL).
    edit.textContent = rule.builtIn ? 'Edit' : 'Edit content';
    edit.addEventListener('click', () => openRuleModal(rule));
    actions.appendChild(edit);
  }
  if (rule.remove) {
    const del = el('button', 'ghost danger');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', rule.remove);
    actions.appendChild(del);
  }
  row.append(copy, actions);
  return row;
}

function ruleTag(kind, value) {
  return `<span class="ruletag ${esc(kind)}">${esc(value)}</span>`;
}

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Whole-hour clock label with am/pm, no minutes: 9 -> "9 AM", 0 -> "12 AM", 15 -> "3 PM".
function formatHour12(hour) {
  if (hour === null || hour === undefined || hour === '') return '';
  const h = Number(hour);
  const period = h < 12 ? 'AM' : 'PM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display} ${period}`;
}

function ordinalDay(day) {
  const n = Number(day);
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

// Human schedule for a rule row. Event -> "Once triggered"; daily -> hour;
// weekly/monthly -> day + hour when a day is set.
function ruleScheduleLabel(rule) {
  const hour = formatHour12(rule.scheduledHour);
  const at = hour ? ` · ${hour}` : '';
  const hasDay = rule.scheduledDay !== null && rule.scheduledDay !== undefined && rule.scheduledDay !== '';
  switch (rule.cadence) {
    case 'event': return 'Once triggered';
    case 'hourly': return 'Hourly';
    case 'daily': return `Daily${at}`;
    case 'weekly': return `Weekly${hasDay ? ` · ${weekdayNames[rule.scheduledDay] || ''}` : ''}${at}`;
    case 'monthly': return `Monthly${hasDay ? ` · ${ordinalDay(rule.scheduledDay)}` : ''}${at}`;
    default: return rule.cadence || 'Once triggered';
  }
}

// Rule-row chips: the human schedule, and a "custom" tag for user-created rules
// (built-in rules are unlabeled).
// A rule "needs input" when it declares user facts (by kind) that are still
// unanswered. The facts layer is decoupled: the rule references keys, and the
// answer state comes from /v1/facts/needs rather than from the rule itself.
function ruleNeedsInput(rule) {
  const entry = rule.kind ? state.factNeeds.byKind[rule.kind] : null;
  return Boolean(entry && entry.facts.some((fact) => !fact.satisfied));
}

function ruleMetaTags(rule) {
  const tags = [ruleTag('status', ruleScheduleLabel(rule))];
  if (!rule.builtIn) tags.push(ruleTag('status', 'custom'));
  if (ruleNeedsInput(rule)) tags.push(ruleTag('needsinput', 'Needs input'));
  return `<div class="ruletags">${tags.join('')}</div>`;
}

// Day options for the schedule picker: weekdays for weekly, 1..28 for monthly.
function ruleDayOptions(cadence, selected) {
  const sel = (value) => (String(selected ?? '') === String(value) ? ' selected' : '');
  if (cadence === 'weekly') {
    return weekdayNames.map((name, i) => `<option value="${i}"${sel(i)}>${name}</option>`).join('');
  }
  if (cadence === 'monthly') {
    let opts = '';
    for (let d = 1; d <= 28; d += 1) opts += `<option value="${d}"${sel(d)}>${ordinalDay(d)}</option>`;
    return opts;
  }
  return '<option value="">—</option>';
}

// Rebuild the day field for the current cadence and show it only for weekly/monthly.
function syncRuleDayField(form, selected) {
  const cadence = form.elements.cadence ? form.elements.cadence.value : '';
  const dayField = form.querySelector('.ruleday');
  const daySelect = form.elements.scheduledDay;
  if (dayField && daySelect) {
    const show = cadence === 'weekly' || cadence === 'monthly';
    dayField.hidden = !show;
    if (show) daySelect.innerHTML = ruleDayOptions(cadence, selected);
  }
  // Event- and hourly-triggered rules run when they fire, not at a set hour, so a
  // run hour does not apply.
  const hourField = form.querySelector('.rulehour');
  if (hourField) hourField.hidden = cadence === 'event' || cadence === 'hourly';
}

function ruleToggle(rule) {
  // A rule that still needs user input cannot be enabled: the switch is disabled
  // until the required facts are answered in the "Needs your input" card above.
  if (ruleNeedsInput(rule)) {
    const blocked = el('button', 'switchbtn');
    blocked.type = 'button';
    blocked.disabled = true;
    blocked.title = 'Answer the question in "Needs your input" above to enable this rule.';
    blocked.setAttribute('aria-label', `${rule.title} needs input before it can be enabled`);
    blocked.innerHTML = '<span></span><b>Off</b>';
    return blocked;
  }
  const button = el('button', `switchbtn${rule.enabled ? ' on' : ''}`);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(Boolean(rule.enabled)));
  button.setAttribute('aria-label', `${rule.enabled ? 'Disable' : 'Enable'} ${rule.title}`);
  button.innerHTML = `<span></span><b>${rule.enabled ? 'On' : 'Off'}</b>`;
  button.addEventListener('click', rule.toggle);
  return button;
}

// Every rule's logic is fixed; only its delivery schedule is editable. Persisted
// to the backend by kind (no client-side override store).
function openBuiltInRuleModal(rule) {
  const panel = el('div');
  panel.innerHTML = `<div class="sechdr"><h3>Edit rule</h3><button class="ghost" type="button" id="closeModal">Close</button></div>`;
  const form = el('form', 'formgrid');
  form.innerHTML = `<div class="rulecopy"><div class="nm">${esc(rule.title)}</div>${rule.description ? `<div class="sub">${esc(rule.description)}</div>` : ''}</div>
    <div class="cardsub">Built-in rule. Its logic is fixed — you can turn it on or off and change when it runs.</div>
    <div class="split"><label>Cadence<select name="cadence">${['event', 'hourly', 'daily', 'weekly', 'monthly'].map((c) => `<option${rule.cadence === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label><label class="ruleday" hidden>Day<select name="scheduledDay">${ruleDayOptions(rule.cadence, rule.scheduledDay)}</select></label><label class="rulehour">Run hour<select name="scheduledHour">${ruleHourOptions(rule.scheduledHour)}</select></label></div>
    <div class="row"><button class="primary" type="submit">Save</button><span class="message"></span></div>`;
  panel.appendChild(form);
  modal(panel);
  $('#closeModal').addEventListener('click', closeModal);
  syncRuleDayField(form, rule.scheduledDay);
  form.elements.cadence.addEventListener('change', () => syncRuleDayField(form, rule.scheduledDay));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const cadence = data.cadence || rule.cadence;
    const triggered = cadence === 'event' || cadence === 'hourly';
    const message = form.querySelector('.message');
    try {
      await api('/v1/rules/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: rule.kind,
          cadence,
          scheduledHour: triggered || data.scheduledHour === '' ? null : Number(data.scheduledHour),
          scheduledDay: data.scheduledDay === '' || data.scheduledDay === undefined ? null : Number(data.scheduledDay),
        }),
      });
      closeModal();
      toast('Rule saved.');
      await loadData();
      renderSettings();
    } catch (error) {
      message.textContent = (error && error.message) || 'Could not save the schedule.';
    }
  });
}

function openRuleModal(existingRule = null) {
  if (existingRule?.builtIn) return openBuiltInRuleModal(existingRule);
  const panel = el('div');
  panel.innerHTML = `<div class="sechdr"><h3>${existingRule ? 'Edit rule' : 'Create rule'}</h3><button class="ghost" type="button" id="closeModal">Close</button></div>`;
  const form = el('form', 'formgrid generaterule');
  const hasPreview = Boolean(existingRule);
  form.innerHTML = `<label>Rule prompt<textarea name="text" required placeholder="Generate a weekly rule that flags brokerage cash above 25% and explains why it matters.">${esc(existingRule?.sourceText || '')}</textarea></label>
    <div class="row"><button class="ghost" type="button" id="previewRule">Preview</button><span class="message"></span></div>
    <div class="rulepreview" id="rulePreview"${existingRule ? '' : ' hidden'}>${existingRule ? rulePreviewMarkup(existingRule) : ''}</div>
    <div class="deliverysettings" id="deliverySettings"${hasPreview ? '' : ' hidden'}><div class="nm">Delivery settings</div><div class="cardsub">Category and scope are inferred from your description (shown above). Choose when the rule runs.</div><div class="split"><label>Cadence<select name="cadence"><option${existingRule?.cadence === 'event' ? ' selected' : ''}>event</option><option${existingRule?.cadence === 'hourly' ? ' selected' : ''}>hourly</option><option${existingRule?.cadence === 'daily' ? ' selected' : ''}>daily</option><option${existingRule?.cadence === 'weekly' ? ' selected' : ''}>weekly</option><option${existingRule?.cadence === 'monthly' ? ' selected' : ''}>monthly</option></select></label><label class="ruleday" hidden>Day<select name="scheduledDay">${ruleDayOptions(existingRule?.cadence, existingRule?.scheduledDay)}</select></label><label class="rulehour">Run hour<select name="scheduledHour">${ruleHourOptions(existingRule?.scheduledHour)}</select></label></div></div>
    <div class="row"><button class="primary" type="submit" id="saveRule"${hasPreview ? '' : ' hidden disabled'}>${existingRule ? 'Save changes' : 'Create rule'}</button></div>`;
  panel.appendChild(form);
  modal(panel);
  $('#closeModal').addEventListener('click', closeModal);
  syncRuleDayField(form, existingRule?.scheduledDay);
  form.elements.cadence.addEventListener('change', () => syncRuleDayField(form, existingRule?.scheduledDay));
  form.elements.text.addEventListener('input', () => {
    if (existingRule) return;
    $('#deliverySettings').hidden = true;
    $('#saveRule').hidden = true;
    $('#saveRule').disabled = true;
    $('#rulePreview').hidden = true;
    $('#rulePreview').innerHTML = '';
  });
  $('#previewRule').addEventListener('click', async () => {
    const data = customRuleFormData(form);
    const button = $('#previewRule');
    button.disabled = true;
    form.querySelector('.message').textContent = 'Generating the rule…';
    form.querySelector('.message').classList.remove('error');
    try {
      // Author + validate the SQL without persisting, so the user sees the
      // generated query and inferred category/scope before committing.
      const preview = await api('/v1/rules/custom/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      applyRulePreview(form, preview);
      $('#rulePreview').hidden = false;
      $('#rulePreview').innerHTML = rulePreviewMarkup(preview);
      $('#deliverySettings').hidden = false;
      $('#saveRule').hidden = false;
      $('#saveRule').disabled = false;
      form.querySelector('.message').textContent = '';
    } catch (error) {
      form.querySelector('.message').textContent = error.message;
      form.querySelector('.message').classList.add('error');
    } finally {
      button.disabled = false;
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('#saveRule').disabled) return;
    const data = customRuleFormData(form);
    const submit = event.submitter;
    submit.disabled = true;
    try {
      if (existingRule) {
        // Editing a custom rule: regenerate its SQL only when the description
        // actually changed (re-authoring invokes the model and is non-deterministic,
        // so a schedule-only edit must not silently rewrite the query), then apply
        // the schedule. Both are keyed by kind — separate backend concerns.
        if (data.text !== (existingRule.sourceText || '')) {
          await api('/v1/rules/custom/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: existingRule.kind, text: data.text }),
          });
        }
        await api('/v1/rules/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: existingRule.kind, cadence: data.cadence, scheduledHour: data.scheduledHour, scheduledDay: data.scheduledDay }),
        });
      } else {
        // Creating a custom rule: the model authors deterministic SQL from the
        // description, validated read-only before it is saved (source = 'user').
        await api('/v1/rules/custom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
      }
      await loadData();
      closeModal();
      toast(existingRule ? 'Rule updated.' : 'Rule created.');
      renderSettings();
    } catch (error) {
      form.querySelector('.message').textContent = error.message;
      form.querySelector('.message').classList.add('error');
    } finally {
      submit.disabled = false;
    }
  });
}

// The payload the custom-rule endpoints accept: the natural-language text plus the
// delivery schedule. Category and scope are authored by the model (not sent), so
// they are deliberately omitted — the endpoints reject unknown fields.
function customRuleFormData(form) {
  const data = Object.fromEntries(new FormData(form));
  const cadence = data.cadence || 'event';
  // Event/hourly rules are triggered, not scheduled, so they have no run hour.
  const triggered = cadence === 'event' || cadence === 'hourly';
  return {
    text: data.text,
    cadence,
    scheduledHour: triggered || data.scheduledHour === '' ? null : Number(data.scheduledHour),
    scheduledDay: data.scheduledDay === '' || data.scheduledDay === undefined ? null : Number(data.scheduledDay),
  };
}

function applyRulePreview(form, preview) {
  form.elements.cadence.value = preview.cadence;
  form.elements.scheduledHour.value = preview.scheduledHour === null || preview.scheduledHour === undefined ? '' : String(preview.scheduledHour);
  syncRuleDayField(form, preview.scheduledDay);
}

// The generated-rule preview: the model-inferred category/scope, the schedule, the
// authored SQL, and (on preview) the execution strategy. Shown for both a fresh
// preview (a RuleSqlDraft-backed preview object) and an existing custom rule.
function ruleDomainLabel(domain) {
  const entry = ruleDomains.find(([key]) => key === domain);
  return entry ? entry[1] : (domain || '—');
}

function rulePreviewMarkup(rule) {
  return `<div class="rulepreviewgrid">
    <div><span>Category</span><b>${esc(ruleDomainLabel(rule.domain))}</b></div>
    <div><span>Scope</span><b>${esc(rule.scope || '—')}</b></div>
    <div><span>Schedule</span><b>${esc(ruleScheduleLabel(rule))}</b></div>
  </div>
  <div class="ruletags">${ruleTag('status', 'Custom SQL')}</div>
  ${rule.sql ? `<pre class="rulesql">${esc(rule.sql)}</pre>` : ''}
  ${rule.strategy ? `<div class="sub">${esc(rule.strategy)}</div>` : ''}`;
}

function ruleHourOptions(selected) {
  const current = selected === null || selected === undefined || selected === '' ? '9' : String(selected);
  const options = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const value = String(hour);
    options.push(`<option value="${value}"${current === value ? ' selected' : ''}>${formatHour12(hour)}</option>`);
  }
  return options.join('');
}

async function openPlaidLink() {
  if (!window.Plaid) throw new Error('Plaid Link failed to load. Check network access to cdn.plaid.com.');
  const { link_token: linkToken } = await api('/v1/plaid/link-token', { method: 'POST' });
  const handler = window.Plaid.create({
    token: linkToken,
    onSuccess: async (publicToken) => {
      try {
        await api('/v1/plaid/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ public_token: publicToken }),
        });
        await loadData();
        toast('Bank linked.');
        render();
      } catch (error) {
        toast(`Plaid exchange failed: ${error.message}`);
      }
    },
    onExit: (error) => {
      if (error) toast(`Plaid Link closed: ${error.display_message || error.error_message || 'No bank linked.'}`);
    },
  });
  handler.open();
}

async function openPlaidAccountSelection(account) {
  if (!window.Plaid) throw new Error('Plaid Link failed to load. Check network access to cdn.plaid.com.');
  const connection = account?.externalId ? account : plaidConnectionForAccount(account);
  const itemId = account.metadata?.plaidItemId
    || connection?.externalId
    || null;
  if (!itemId) throw new Error('No Plaid Item id is available for this account.');
  const { link_token: linkToken } = await api('/v1/plaid/update-link-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_id: itemId, accounts: true }),
  });
  const handler = window.Plaid.create({
    token: linkToken,
    onSuccess: async () => {
      try {
        const result = await api('/v1/plaid/update-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_id: itemId }),
        });
        await loadData();
        toast(result.removedAccounts ? `Plaid account selection updated. Removed ${result.removedAccounts} local account${result.removedAccounts === 1 ? '' : 's'}.` : 'Plaid account selection updated.');
        renderSettings();
      } catch (error) {
        toast(`Plaid account update failed: ${error.message}`);
      }
    },
    onExit: (error) => {
      if (error) toast(`Plaid Link closed: ${error.display_message || error.error_message || 'Account selection was not changed.'}`);
    },
  });
  handler.open();
}

async function openProviderConnection() {
  try {
    await openPlaidLink();
  } catch (error) {
    toast(error.message);
  }
}

function normalizedProviderText(value) {
  return String(value || '').trim().toLowerCase();
}

function connectionAccountIds(connection) {
  const ids = connection?.metadata?.accountIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

function plaidConnectionForAccount(account) {
  const byAccountId = state.connections.find((connection) =>
    connection.provider === 'plaid'
    && account.providerAccountId
    && connectionAccountIds(connection).includes(String(account.providerAccountId)));
  if (byAccountId) return byAccountId;
  const matches = state.connections.filter((connection) =>
    connection.provider === 'plaid'
    && normalizedProviderText(connection.institution) === normalizedProviderText(account.institution));
  return matches.length === 1 ? matches[0] : null;
}

function plaidAccountGroups(accounts) {
  const groups = new Map();
  for (const account of accounts) {
    const connection = plaidConnectionForAccount(account);
    const key = connection?.externalId || `institution:${normalizedProviderText(account.institution) || account.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        institution: connection?.institution || account.institution || 'Unknown institution',
        connection,
        accounts: [],
      });
    }
    groups.get(key).accounts.push(account);
  }
  return [...groups.values()].sort((a, b) => a.institution.localeCompare(b.institution));
}

// Whether a Plaid connection needs the user to re-authenticate — either it has
// already lapsed (status login_required) or its OAuth consent expires within 3 days.
// Returns null when the connection is healthy.
function connectionReauthState(connection) {
  if (!connection) return null;
  if (connection.status === 'login_required') return { level: 'error', label: 'Reconnect needed' };
  const expiresAt = connection.metadata?.consentExpiresAt;
  if (expiresAt) {
    const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
    if (Number.isFinite(days) && days <= 3) {
      return { level: 'warn', label: days <= 0 ? 'Expired — reconnect' : `Expires in ${days} day${days === 1 ? '' : 's'}` };
    }
  }
  return null;
}

function renderAccountManager(view, provider, accounts) {
  const sec = el('div', 'sec');
  sec.innerHTML = '<div class="sechdr"><h3>Manage accounts</h3><button class="primary pageaction" type="button">Add Plaid account</button></div>';
  const add = sec.querySelector('button');
  add.addEventListener('click', () => openProviderConnection());

  if (!accounts.length) {
    sec.appendChild(empty('No Plaid accounts yet.'));
    view.appendChild(sec);
    return;
  }

  const list = el('div', 'accountlist');
  for (const group of plaidAccountGroups(accounts)) {
    const row = el('div', 'accountrow');
    const reauth = connectionReauthState(group.connection);
    const accountsMarkup = group.accounts.map((item) => {
      const type = String(item.type || 'account').replaceAll('_', ' ');
      const profile = accountProfile(item);
      return `<div class="accountidentity accountmember"><div class="accticon ${esc(profile.cls)}" title="${esc(profile.label)}" aria-label="${esc(profile.label)}" role="img">${accountIcon(profile.icon)}</div><div><div class="nm">${esc(item.name)}</div><div class="sub">${esc(type)} - ${esc(item.currency)}</div></div></div>`;
    }).join('');
    const badge = reauth ? `<span class="reauthbadge ${esc(reauth.level)}">${esc(reauth.label)}</span>` : '';
    row.innerHTML = `<div class="accountgroup"><div class="nm">${esc(group.institution)}${badge}</div><div class="accountmembers">${accountsMarkup}</div></div>`;
    const actions = el('div', 'row');
    const edit = el('button', reauth ? 'primary' : 'ghost');
    edit.type = 'button';
    edit.textContent = reauth ? 'Reconnect' : 'Edit';
    edit.addEventListener('click', async () => {
      edit.disabled = true;
      try {
        await openPlaidAccountSelection(group.connection || group.accounts[0]);
      } catch (error) {
        toast(error.message);
      } finally {
        edit.disabled = false;
      }
    });
    actions.append(edit);
    row.appendChild(actions);
    // Landed here from an insight's Reconnect button: highlight the target row.
    if (state.highlightConnection && group.connection?.externalId === state.highlightConnection) {
      row.classList.add('highlight');
      setTimeout(() => row.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    }
    list.appendChild(row);
  }
  state.highlightConnection = null;
  sec.appendChild(list);
  view.appendChild(sec);
}

function modal(content) {
  const root = $('#modalRoot');
  root.replaceChildren();
  const bg = el('div', 'modal-bg');
  const box = el('div', 'modal');
  if (content.dataset.modalClass) box.classList.add(content.dataset.modalClass);
  box.appendChild(content);
  bg.appendChild(box);
  bg.addEventListener('click', (event) => {
    if (event.target === bg) closeModal();
  });
  root.appendChild(bg);
}

function closeModal() {
  activeCreditUpload = null;
  $('#modalRoot').replaceChildren();
}

function render() {
  renderSidebar();
  if (state.section === 'feed') renderFeed();
  else if (state.section === 'banks') renderBanks();
  else if (state.section === 'brokerage') renderBrokerage();
  else if (state.section === 'credit') renderCredit();
  else if (state.section === 'dashboards') renderDashboards();
  else renderSettings();
  renderChat();
}

function activeThread() {
  return state.threads.find((thread) => thread.id === state.thread) || null;
}

function saveThreads() {
  localStorage.setItem('finora.threads.v1', JSON.stringify(state.threads.slice(0, 20)));
}

function loadThreads() {
  try {
    state.threads = JSON.parse(localStorage.getItem('finora.threads.v1') || '[]');
    state.thread = state.threads[0]?.id || null;
  } catch {
    state.threads = [];
  }
}

function newThread() {
  const thread = { id: `t${Date.now().toString(36)}`, title: 'New chat', messages: [], ts: Date.now() };
  state.threads.unshift(thread);
  state.thread = thread.id;
  saveThreads();
  return thread;
}

function ensureThread() {
  return activeThread() || newThread();
}

async function send(text = $('#input').value) {
  const value = text.trim();
  if (!value) return;
  const thread = ensureThread();
  thread.messages.push({ role: 'user', content: value });
  if (thread.messages.filter((msg) => msg.role === 'user').length === 1) thread.title = value.slice(0, 42);
  thread.messages.push({ role: 'assistant', content: pendingChatContent });
  thread.ts = Date.now();
  $('#input').value = '';
  saveThreads();
  renderChat();
  try {
    const response = await api('/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        section: state.section,
        contextAttachments: state.contextAttachments,
        messages: thread.messages
          .filter((msg) => msg.content !== pendingChatContent)
          .slice(-10)
          .map((msg) => ({ role: msg.role, content: msg.content })),
      }),
    });
    state.contextAttachments = [];
    render();
    const pending = thread.messages.at(-1);
    if (pending?.content === pendingChatContent) {
      pending.content = response.reply;
    }
  } catch (error) {
    const pending = thread.messages.at(-1);
    if (pending?.content === pendingChatContent) pending.content = `Model unavailable: ${error.message}`;
    toast(`Chat failed: ${error.message}`);
  }
  saveThreads();
  renderChat();
}

function renderThreadBar() {
  const thread = activeThread();
  $('#threadTitle').textContent = thread?.title || 'New chat';
  $('#threadsBtn').textContent = `History${state.threads.length ? ` ${state.threads.length}` : ''}`;
  $('#newThreadBtn').textContent = 'New';
}

function renderThreadMenu() {
  const menu = $('#threadMenu');
  menu.replaceChildren();
  if (!state.threads.length) {
    const item = el('div', 'ti');
    item.innerHTML = '<span class="t mut">No conversations yet.</span>';
    menu.appendChild(item);
    return;
  }
  for (const thread of state.threads) {
    const item = el('div', `ti${thread.id === state.thread ? ' active' : ''}`);
    item.innerHTML = `<span class="t">${esc(thread.title)}</span>`;
    item.addEventListener('click', () => {
      state.thread = thread.id;
      menu.hidden = true;
      renderChat();
    });
    menu.appendChild(item);
  }
}

function renderSuggest() {
  const target = $('#suggest');
  target.replaceChildren();
  if (activeThread()?.messages.length) return;
  const suggestions = state.section === 'brokerage'
    ? ['Summarize my holdings', 'Show brokerage activity']
    : state.section === 'credit'
      ? ['What credit report files are supported?', 'How should I upload a bureau PDF?']
    : state.section === 'dashboards'
      ? ['What dashboards are saved?', 'Show saved artifacts']
      : ['Summarize my cash flow', 'Show me recent transactions', 'What can the local model do?'];
  for (const text of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', () => send(text));
    target.appendChild(button);
  }
}

function renderChat() {
  renderThreadBar();
  $('#contextBar').textContent = state.section === 'banks' ? `Context: Banking${account(state.accountId) ? ` / ${account(state.accountId).name}` : ''}` : `Context: ${currentSectionLabel()}`;
  const attachments = $('#contextAttachments');
  attachments.replaceChildren();
  attachments.hidden = !state.contextAttachments.length;
  for (const item of state.contextAttachments) {
    const chip = el('button', 'contextchip');
    chip.type = 'button';
    chip.title = 'Remove from chat context';
    chip.innerHTML = `<span>${esc(attachmentTypeLabel(item.type))}</span>${esc(item.title)}`;
    chip.addEventListener('click', () => {
      state.contextAttachments = state.contextAttachments.filter((candidate) => candidate.id !== item.id);
      renderChat();
    });
    attachments.appendChild(chip);
  }
  const messages = $('#msgs');
  messages.replaceChildren();
  for (const msg of activeThread()?.messages || []) {
    const node = el('div', `msg ${msg.role === 'user' ? 'user' : 'bot'}`);
    if (msg.content === pendingChatContent) {
      node.classList.add('thinking');
      node.innerHTML = '<span>Thinking</span><span class="typingdots"><i></i><i></i><i></i></span>';
    } else if (msg.role === 'assistant') {
      const markdown = el('div', 'markdown');
      markdown.innerHTML = renderMarkdown(msg.content);
      node.appendChild(markdown);
    } else {
      node.textContent = msg.content;
    }
    messages.appendChild(node);
  }
  messages.scrollTop = messages.scrollHeight;
  renderSuggest();
}

function applyHash() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!hash) return;
  const [section, sub] = hash.split('/');
  if (sections.some((item) => item.id === section)) state.section = section;
  if (section === 'banks' && bankTabs.some(([id]) => id === sub)) state.bankTab = sub;
  if (section === 'brokerage' && brokerageTabs.some(([id]) => id === sub)) state.brokerageTab = sub;
  normalizeAccountSelection();
}

$('#threadsBtn').addEventListener('click', () => {
  const menu = $('#threadMenu');
  if (menu.hidden) renderThreadMenu();
  menu.hidden = !menu.hidden;
});
$('#newThreadBtn').addEventListener('click', () => {
  newThread();
  renderChat();
  $('#input').focus();
});
$('#sendBtn').addEventListener('click', () => send());
$('#input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    send();
  }
});
$('#input').addEventListener('input', (event) => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
});
$('#navToggle').addEventListener('click', () => toggleDrawer('nav'));
$('#chatToggle').addEventListener('click', () => toggleDrawer('chat'));
$('#scrim').addEventListener('click', closeDrawers);
document.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('.dashactions')) return;
  closeDashboardMenus();
});
addEventListener('dragover', (event) => {
  if (state.section !== 'credit') return;
  event.preventDefault();
});
addEventListener('drop', (event) => {
  if (state.section !== 'credit' || event.defaultPrevented) return;
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file && activeCreditUpload) activeCreditUpload(file);
});
addEventListener('hashchange', () => {
  applyHash();
  render();
});

loadThreads();
applyHash();
loadData().then(render).catch((error) => {
  $('#view').replaceChildren(empty(error.message));
});
checkForUpdate();
