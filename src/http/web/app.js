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
  from: isoDate(before),
  to: isoDate(today),
  accounts: [],
  summary: [],
  transactions: [],
  nextCursor: null,
  connections: [],
  brokerageSummary: [],
  brokerageTransactions: [],
  brokerageHoldings: [],
  balances: [],
  dashboards: [],
  settings: [],
  llm: null,
  alertRules: [],
  alertMutes: [],
  credit: { hasData: false, reports: [], accounts: [], inquiries: [], suggestions: [], utilization: null, latest: null },
  creditTab: 'latest',
  settingsTab: 'models',
  notificationChannel: 'telegram',
  threads: [],
  thread: null,
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
const settingsTabs = [['models', 'Models'], ['banks', 'Banks'], ['brokerage', 'Brokerage'], ['notifications', 'Notifications'], ['insights', 'Alerts & Insights']];
const creditTabs = [['latest', 'Latest report overview'], ['reports', 'Reports']];
const connectorCopy = {
  plaid: {
    title: 'Plaid banking',
    sourceKey: 'active_bank_source',
    sourceLabel: 'Active banking source',
    sourceFallback: 'local_imports',
    accountLabel: 'bank account',
    empty: 'No Plaid Items are connected yet. Use Plaid Link to add a banking connection.',
    limitation: 'Plaid Link and token exchange are wired. Transactions sync automatically on the hourly provider loop after the service starts.',
    connectedText: 'A connection is active when its Plaid Item is active and has a saved access token for transaction sync.',
  },
  snaptrade: {
    title: 'SnapTrade brokerage',
    sourceKey: 'active_brokerage_source',
    sourceLabel: 'Active brokerage source',
    sourceFallback: 'local_brokerage',
    accountLabel: 'brokerage account',
    empty: 'No SnapTrade connections are connected yet. Open the Connection Portal to add a brokerage connection.',
    limitation: 'SnapTrade Connection Portal is wired. Brokerage accounts, positions, balances, and activities sync on the provider loop with a 24 hour cooldown.',
    connectedText: 'A connection is active when SnapTrade has saved provider credentials for the brokerage account.',
  },
};
const insightCategories = [
  ['Cash flow', 'income timing, bill runway, idle cash, recurring spend'],
  ['Spending', 'large charges, duplicates, subscriptions, fees, categorization cleanup'],
  ['Credit', 'utilization, card interest, late or fee signals'],
  ['Investments', 'cash drag, concentration, portfolio movement, executed orders'],
  ['Connections', 'provider status, missing tokens, stale cursors, sync health'],
];
const sampleInsightRules = [
  ['Connection health', 'event', 'all', 'D', null, 'Notify when Plaid or SnapTrade status is not active, a token is missing, or Plaid cursor is missing.'],
  ['Idle cash scan', 'weekly', 'banking', 'L', 9, 'Find cash balances above the local threshold and generate a short review note from the account evidence.'],
  ['Low balance risk', 'daily', 'banking', 'D', 9, 'Flag checking or savings balances that fall below the local safety threshold.'],
  ['Negative balance', 'event', 'banking', 'D', null, 'Notify immediately when an account balance is negative or an overdraft-like transaction posts.'],
  ['New large transaction', 'event', 'banking', 'L', null, 'Notify when any posted outflow exceeds $500 or 3x the account median outflow.'],
  ['Duplicate or unusual charge', 'event', 'banking', 'L+', null, 'Prefilter similar merchant charges, then ask the local model to accept or reject the duplicate signal.'],
  ['Subscription drift', 'weekly', 'banking', 'L', 9, 'Flag recurring merchants whose amount increased by more than 15% from the prior charge.'],
  ['Trial conversion watch', 'daily', 'banking', 'L+', 9, 'Detect trial-like merchants and ask the local model whether the charge looks like a conversion.'],
  ['Discretionary spending review', 'weekly', 'banking', 'L', 9, 'Summarize dining, shopping, entertainment, and travel spend that moved materially from baseline.'],
  ['Cash runway', 'monthly', 'banking', 'L', 9, 'Estimate months of cash runway from latest cash balance and average monthly outflows.'],
  ['Expected income late', 'event', 'banking', 'L+', null, 'Prefilter missed income cadence and generate a review item when expected payroll or deposits are absent.'],
  ['Fee and interest watch', 'event', 'banking', 'D', null, 'Flag bank fees, credit card interest, and cash advance charges as they post.'],
  ['Credit utilization', 'daily', 'credit', 'D', 9, 'Notify when credit card balance exceeds 30% or 70% of known limit.'],
  ['Credit report review', 'monthly', 'credit', 'L+', 9, 'Review new bureau report changes, hard inquiries, derogatory lines, and dispute candidates.'],
  ['Credit payment due', 'weekly', 'credit', 'L', 9, 'Surface card balances and payment timing when due-date evidence is available.'],
  ['Brokerage cash drag', 'weekly', 'brokerage', 'L', 9, 'Flag brokerage cash above 25% of portfolio value unless muted.'],
  ['Portfolio concentration', 'weekly', 'brokerage', 'L', 9, 'Flag any single holding above 20% of tracked holdings value.'],
  ['Single name net-worth exposure', 'weekly', 'all', 'L+', 9, 'Combine holdings and balances to review outsized exposure to one symbol or company.'],
  ['Allocation drift', 'monthly', 'brokerage', 'L', 9, 'Compare current holdings mix with the saved target allocation when available.'],
  ['Executed order review', 'event', 'brokerage', 'L', null, 'Summarize buy, sell, dividend reinvestment, and option-like brokerage activity.'],
  ['Dividend or interest received', 'event', 'brokerage', 'L', null, 'Notify on income-like brokerage transactions with symbol and account context.'],
  ['Weekly financial health check', 'weekly', 'all', 'L', 9, 'Generate a concise digest of balances, spending, investments, and connection health.'],
  ['Net worth movement', 'monthly', 'all', 'L', 9, 'Compare latest balances with the prior month and explain the largest movers.'],
  ['Stale local imports', 'weekly', 'all', 'D', 9, 'Flag accounts that have not received a file import or provider sync recently.'],
];
const builtInRulesKey = 'finora.builtInRules.v1';
const notificationChannels = {
  telegram: {
    title: 'Telegram',
    summary: 'Best for direct, low-volume personal alerts.',
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
      ['Save target', 'Save the bot token and selected channel so alerts have one clear delivery destination.'],
    ],
    note: 'Slack still needs a target channel. Keep this as one channel-level credential block until a channel picker is available.',
  },
};
let activeCreditUpload = null;
const pendingChatContent = '__FINORA_THINKING__';

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

function shortMoney(amount, currency = 'USD') {
  const value = Number(amount || 0) / 100;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value);
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
      scopedTransactions().filter((txn) => txn.amountMinor < 0),
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
      scopedTransactions().filter((txn) => txn.amountMinor < 0),
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

  if (name.includes('pnl') || name.includes('brokerage_realized')) {
    return groupSum(
      state.brokerageTransactions,
      (txn) => `${monthKey(txn.date)}${params.groupBy === 'account' ? `|${accountLabel(txn.accountId)}` : ''}`,
      (row, txn) => {
        row.pnl_cents += Number(txn.amountMinor || 0);
      },
      (key) => {
        const [period, accountName] = key.split('|');
        return { period, account: accountName, pnl_cents: 0 };
      },
    ).sort((a, b) => `${a.period}${a.account || ''}`.localeCompare(`${b.period}${b.account || ''}`));
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
      next[`__${item.field}`] = cents ? Number(row[item.field] || 0) / 100 : Number(row[item.field] || 0);
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
        x: { field: x, type: vegaType(x), title: chartLabel(x), axis: { labelAngle: -25 } },
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
      x: { field: x, type: vegaType(x), title: chartLabel(x), axis: { labelAngle: -25 } },
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
  vegaEmbed(chart, spec, { actions: false, renderer: 'svg', theme: 'none', ast: true, tooltip: false }).catch((error) => {
    chart.classList.remove('vlchart');
    chart.replaceChildren(empty(`Could not render interactive chart: ${error.message || error}`));
  });
  return true;
}

function renderArtifactChart(host, saved) {
  const artifact = normalizeArtifact(saved);
  const rows = resolveArtifactRows(artifact);
  const render = artifact.render || {};
  const format = artifact.style?.numberFormat || render.options?.yFormat || 'number';
  const x = render.x || ['period', 'month', 'category', 'merchant', 'symbol', 'account', 'name'].find((key) => rows.some((row) => row[key] !== undefined)) || Object.keys(rows[0] || {})[0];
  const series = chartSeries(artifact, rows);
  const wrap = el('div', `artifact ${artifact.style?.theme === 'dark' ? 'dark' : ''}`);
  wrap.innerHTML = `<div class="ahdr"><div><div class="atitle">${esc(artifact.title)}</div>${artifact.description ? `<div class="adesc">${esc(artifact.description)}</div>` : ''}</div></div>`;
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

function providerManagedAccounts(provider, accounts = state.accounts) {
  return accounts.filter((item) => item.source === provider);
}

function accountLabel(id) {
  const item = account(id);
  return item ? `${item.institution} / ${item.name}` : 'Unknown account';
}

function accountInitial(item) {
  return (item?.institution || item?.name || 'F').trim().slice(0, 1).toUpperCase();
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

function providerRows(provider) {
  return state.connections.filter((item) => item.provider === provider);
}

function providerConnectionState(provider) {
  const rows = providerRows(provider);
  const active = rows.filter((item) => item.status === 'active' && item.hasAccessToken && (provider !== 'plaid' || item.hasCursor));
  const needsReview = rows.filter((item) => item.status !== 'active' || !item.hasAccessToken || (provider === 'plaid' && !item.hasCursor));
  return { rows, active, needsReview };
}

function providerSummary(provider, accounts) {
  const { rows, active, needsReview } = providerConnectionState(provider);
  const copy = connectorCopy[provider];
  const source = settingValue(copy.sourceKey, copy.sourceFallback);
  const canSync = provider === 'plaid'
    ? active.length > 0 && rows.every((item) => item.hasCursor)
    : active.length > 0;
  return {
    source,
    total: rows.length,
    active: active.length,
    needsReview: needsReview.length,
    accounts: accounts.length,
    canSync,
    status: active.length ? (needsReview.length ? 'Partial' : 'Active') : 'Not connected',
  };
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

function setSection(id) {
  state.section = id;
  if (id !== 'banks' && id !== 'brokerage') state.accountId = null;
  closeDrawers();
  history.replaceState(null, '', `#${id}${id === 'banks' ? `/${state.bankTab}` : ''}`);
  render();
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
    balances,
    dashboards,
    settings,
    llm,
    alertRules,
    alertMutes,
    credit,
  ] = await Promise.all([
    api('/v1/accounts'),
    api('/v1/summary'),
    api('/v1/transactions?limit=100'),
    api('/v1/provider-connections'),
    api('/v1/brokerage/summary'),
    api('/v1/brokerage/transactions?limit=100'),
    api('/v1/brokerage/holdings'),
    api('/v1/account-balances'),
    api('/v1/dashboards'),
    api('/v1/settings'),
    api('/v1/llm'),
    api('/v1/alert-rules'),
    api('/v1/alert-mutes'),
    api('/v1/credit-reports'),
  ]);
  state.accounts = accounts.items;
  state.summary = summary.items;
  state.transactions = txns.items;
  state.nextCursor = txns.nextCursor;
  state.connections = connections.items;
  state.brokerageSummary = brokerageSummary.items;
  state.brokerageTransactions = brokerageTxns.items;
  state.brokerageHoldings = brokerageHoldings.items;
  state.balances = balances.items;
  state.dashboards = dashboards.items;
  state.settings = settings.items;
  state.llm = llm;
  state.notificationChannel = settingValue('NOTIFICATION_CHANNEL', state.notificationChannel);
  state.alertRules = alertRules.items;
  state.alertMutes = alertMutes.items;
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
    row.innerHTML = `<span class="lbl">${esc(section.label)}</span>`;
    row.addEventListener('click', () => setSection(section.id));
    nav.appendChild(row);
  }
  side.appendChild(nav);
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

function manageAccountsButton(tab) {
  const button = el('button', 'ghost');
  button.type = 'button';
  button.textContent = 'Manage accounts';
  button.addEventListener('click', () => {
    state.settingsTab = tab;
    setSection('settings');
  });
  return button;
}

function sectionActionBar(tab) {
  const bar = el('div', 'sectionactions');
  bar.appendChild(manageAccountsButton(tab));
  return bar;
}

function accountCards(accounts = selectedAccounts(), label = 'accounts') {
  const grid = el('div', 'acctgrid');
  const accountAmount = (item) => {
    const bal = latestBalances().find((row) => row.accountId === item.id);
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
    const bal = latestBalances().find((row) => row.accountId === item.id);
    if (bal) return sum + accountDisplayMinor(item, bal.currentMinor);
    if (item.domain === 'brokerage') return sum + state.brokerageHoldings.filter((holding) => holding.accountId === item.id).reduce((inner, holding) => inner + Number(holding.valueMinor || 0), 0);
    return sum + state.transactions.filter((txn) => txn.accountId === item.id).reduce((inner, txn) => inner + Number(txn.amountMinor || 0), 0);
  }, 0);
  const allCurrency = accounts[0]?.currency || 'USD';
  const allAmountClass = allTotal < 0 ? 'neg' : 'pos';
  const all = el('div', `acctcard allacct${state.accountId ? '' : ' active'}`);
  all.innerHTML = `<div class="accticon allmark" title="All accounts" aria-label="All accounts" role="img">${accountIcon('all')}</div><div class="acctmeta"><div class="nm">All accounts</div><div class="sub">${accounts.length} account${accounts.length === 1 ? '' : 's'}</div></div><div class="acctamount ${allAmountClass}">${money(allTotal, allCurrency)}</div>`;
  all.addEventListener('click', () => {
    state.accountId = null;
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

function transactionTable(rows) {
  const wrap = el('div', 'table-wrap');
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th class="tx-date">Date</th><th>Description</th><th class="tx-account">Account</th><th class="tx-amount r">Amount</th></tr></thead>';
  const body = document.createElement('tbody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">No transactions match.</td></tr>';
  } else {
    for (const txn of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="tx-date">${esc(txn.date)}</td><td>${esc(txn.description)}</td><td class="tx-account">${esc(accountLabel(txn.accountId))}</td><td class="tx-amount r ${txn.amountMinor < 0 ? 'neg' : 'pos'}">${money(txn.amountMinor, txn.currency)}</td>`;
      body.appendChild(tr);
    }
  }
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
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

function tableControls(key, rows, renderFn, itemLabel = 'transaction') {
  const controls = el('div', 'tabletools');
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
  const count = el('span', 'pginfo');
  count.textContent = `${rows.length} ${itemLabel}${rows.length === 1 ? '' : 's'}`;
  controls.append(search, size, count);
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

function tableWithPagination(table, key, total, renderFn) {
  const wrap = el('div');
  wrap.appendChild(table);
  const pager = pagination(key, total, renderFn);
  if (pager) wrap.appendChild(pager);
  return wrap;
}

function renderDataTable(headers, rows, options = {}) {
  const key = options.pageKey;
  const renderFn = options.render || render;
  const filtered = key ? filterTableRows(key, rows) : rows;
  const visibleRows = key ? pageRows(key, filtered) : filtered;
  const wrap = el('div', 'table-wrap');
  if (key) wrap.appendChild(tableControls(key, filtered, renderFn, options.itemLabel));
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>${headers.map((header, index) => `<th class="${index ? 'r' : ''}">${esc(header)}</th>`).join('')}</tr></thead>`;
  const body = document.createElement('tbody');
  if (!visibleRows.length) {
    body.innerHTML = `<tr><td colspan="${headers.length}" class="empty">${esc(options.emptyText || 'No rows match.')}</td></tr>`;
  }
  for (const row of visibleRows) {
    const tr = document.createElement('tr');
    tr.innerHTML = row.map((cell, index) => `<td class="${index ? 'r' : ''}">${cell}</td>`).join('');
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
  view.replaceChildren(topbar('Banking', 'Bank accounts', { hideTitle: true, hideDateRange: true }));
  const accounts = bankAccounts();
  if (!accounts.length) {
    view.appendChild(accountCta('No bank accounts yet', 'Connect a bank through Plaid Link. Bank statement import is not supported in this build.', 'Add bank account', () => openProviderConnection('plaid')));
    return;
  }
  view.appendChild(sectionActionBar('banks'));
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
  for (const txn of rows.filter((item) => item.amountMinor < 0)) {
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
  for (const txn of rows.filter((item) => item.amountMinor < 0)) {
    const key = txn.description || 'Unknown';
    const current = byMerchant.get(key) || { merchant: key, count: 0, amount: 0, currency: txn.currency };
    current.count += 1;
    current.amount += Math.abs(txn.amountMinor);
    byMerchant.set(key, current);
  }
  return [...byMerchant.values()].sort((a, b) => b.amount - a.amount);
}

function recurringRows(rows = selectedTransactions()) {
  const groups = new Map();
  for (const txn of rows.filter((item) => item.amountMinor < 0)) {
    const key = (txn.description || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const current = groups.get(key) || { merchant: txn.description, category: txn.category || 'Uncategorized', count: 0, amount: 0, currency: txn.currency, lastDate: txn.date };
    current.count += 1;
    current.amount += Math.abs(txn.amountMinor);
    if (txn.date > current.lastDate) current.lastDate = txn.date;
    groups.set(key, current);
  }
  return [...groups.values()]
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.amount - a.amount);
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
  const rows = recurringRows();
  const sec = el('div', 'sec');
  const monthly = rows.reduce((sum, item) => sum + item.amount / Math.max(1, item.count), 0);
  sec.innerHTML = `<div class="sechdr"><h3>Recurring</h3><span class="pill">~${money(monthly, rows[0]?.currency || 'USD')}/mo</span></div>`;
  sec.appendChild(rows.length
    ? transactionLikeTable(['Merchant', 'Category', 'Transactions', 'Average', 'Last seen'], rows.map((row) => [
      esc(row.merchant),
      categoryCell(row.category),
      `<span class="pill">${row.count}</span>`,
      `<span class="num neg">${money(Math.round(row.amount / row.count), row.currency)}</span>`,
      esc(row.lastDate),
    ]), { pageKey: `bank-recurring-${state.accountId || 'all'}-${state.from}-${state.to}` })
    : empty('No recurring charges detected yet.'));
  view.appendChild(sec);
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
  const items = [];
  const plaid = state.connections.filter((item) => item.provider === 'plaid');
  const plaidNeedsReview = plaid.filter((item) => item.status !== 'active' || !item.hasAccessToken || !item.hasCursor);
  if (plaidNeedsReview.length) {
    items.push({ zone: 'attention', group: 'Connections', icon: '!', title: `${plaidNeedsReview.length} Plaid connection${plaidNeedsReview.length === 1 ? '' : 's'} need review`, detail: 'Active transaction refresh requires active status, an access token, and a saved cursor.', value: 'Review' });
  }
  for (const item of state.connections.filter((conn) => conn.provider !== 'plaid' && (conn.status !== 'active' || !conn.hasAccessToken))) {
    items.push({ zone: 'attention', group: 'Connections', icon: '!', title: `${item.institution || item.provider} is ${item.status}`, detail: 'Open Settings to review this connection before relying on fresh data.', value: 'Action' });
  }

  const latest = latestBalances();
  for (const bal of latest) {
    if (bal.currentMinor > 0 && bal.cashMinor !== null && bal.cashMinor / bal.currentMinor >= 0.25) {
      items.push({ zone: 'attention', group: 'Brokerage', icon: '$', title: `${account(bal.accountId)?.name || 'Brokerage'} has elevated cash`, detail: `${money(bal.cashMinor, bal.currency)} cash on ${money(bal.currentMinor, bal.currency)} current value.`, value: `${Math.round((bal.cashMinor / bal.currentMinor) * 100)}%` });
    }
  }

  const holdings = selectedBrokerageHoldings();
  const totalHoldings = holdings.reduce((sum, item) => sum + Number(item.valueMinor || 0), 0);
  const largest = holdings.slice().sort((a, b) => Number(b.valueMinor || 0) - Number(a.valueMinor || 0))[0];
  if (largest && totalHoldings > 0 && largest.valueMinor / totalHoldings >= 0.2) {
    items.push({ zone: 'insights', group: 'Portfolio', icon: '%', title: `${largest.symbol || largest.name || 'Top holding'} is your largest position`, detail: `${money(largest.valueMinor, largest.currency)} of ${money(totalHoldings, largest.currency)} tracked holdings.`, value: `${Math.round((largest.valueMinor / totalHoldings) * 100)}%` });
  }

  const monthlySpend = selectedTransactions().filter((txn) => txn.amountMinor < 0).reduce((sum, txn) => sum + Math.abs(txn.amountMinor), 0);
  if (monthlySpend > 0) {
    items.push({ zone: 'insights', group: 'Cash flow', icon: '-', title: 'Spending in selected range', detail: `${selectedTransactions().filter((txn) => txn.amountMinor < 0).length} outflow rows across bank accounts.`, value: shortMoney(monthlySpend) });
  }
  return items;
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
      row.innerHTML = `<div class="feedico ${esc(zone)}">${esc(item.icon)}</div><div class="feedcopy"><div class="t">${esc(item.title)}</div><div class="d">${esc(item.detail)}</div></div><div class="feedactions"><span class="valuechip ${item.amount < 0 ? 'neg' : item.amount > 0 ? 'pos' : ''}">${esc(item.value)}</span><button type="button" class="dismissbtn" title="Dismiss" aria-label="Dismiss insight">×</button></div>`;
      row.querySelector('.dismissbtn').addEventListener('click', () => dismissInsightRow(row, item));
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

function renderImports(host = $('#view'), embedded = false) {
  if (!embedded) host.replaceChildren(topbar('Imports', 'Statement files'));
  const sec = el('div', 'sec');
  sec.innerHTML = '<div class="sechdr"><h3>Statement import</h3><button class="primary" id="openImport">Import statement</button></div><div class="cardsub">CSV, OFX, and QFX files are parsed locally and deduplicated by account plus file content.</div>';
  host.appendChild(sec);
  sec.querySelector('#openImport').addEventListener('click', () => openImportModal());
  const accounts = el('div', 'sec');
  accounts.innerHTML = '<div class="sechdr"><h3>Accounts</h3><button class="ghost" id="openAccount">Create account</button></div>';
  accounts.appendChild(accountCards(bankAccounts(), 'Banks'));
  host.appendChild(accounts);
  accounts.querySelector('#openAccount').addEventListener('click', () => openAccountModal());
}

function selectedBrokerageTransactions() {
  return state.brokerageTransactions.filter((item) => {
    if (state.accountId && item.accountId !== state.accountId) return false;
    if (state.from && item.date < state.from) return false;
    if (state.to && item.date > state.to) return false;
    return true;
  });
}

function selectedBrokerageHoldings() {
  const latest = new Map();
  for (const item of state.brokerageHoldings) {
    if (state.accountId && item.accountId !== state.accountId) continue;
    const key = [item.accountId, item.securityId || item.symbol || item.name || item.securityType || '', item.currency].join('|');
    const current = latest.get(key);
    if (!current
      || item.asOfDate > current.asOfDate
      || (item.asOfDate === current.asOfDate && item.createdAt > current.createdAt)
      || (item.asOfDate === current.asOfDate && item.createdAt === current.createdAt && item.id > current.id)) {
      latest.set(key, item);
    }
  }
  return [...latest.values()].sort((a, b) => Number(b.valueMinor || 0) - Number(a.valueMinor || 0));
}

function selectedBalances() {
  return state.balances.filter((item) => !state.accountId || item.accountId === state.accountId);
}

function latestBalances() {
  const byAccount = new Map();
  for (const item of selectedBalances()) {
    const current = byAccount.get(item.accountId);
    if (!current || item.asOfDate > current.asOfDate) byAccount.set(item.accountId, item);
  }
  return [...byAccount.values()];
}

function renderBrokerage() {
  state.section = 'brokerage';
  renderSidebar();
  const view = $('#view');
  view.replaceChildren(topbar('Brokerage', 'Investments', { hideTitle: true, hideDateRange: true }));
  const accounts = brokerageAccounts();
  if (!accounts.length) {
    view.appendChild(accountCta('No brokerage accounts yet', 'Connect a brokerage through the SnapTrade Connection Portal. Bank statement import is not used for brokerage data.', 'Add brokerage account', () => openProviderConnection('snaptrade')));
    return;
  }
  view.appendChild(sectionActionBar('brokerage'));
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
  const holdingRows = selectedBrokerageHoldings().slice(0, 80);
  if (!holdingRows.length) holdings.appendChild(empty('No holdings in this scope.'));
  else holdings.appendChild(transactionLikeTable(
    ['Symbol', 'Name', 'Quantity', 'Price', 'Value'],
    holdingRows.map((row) => [
      esc(row.symbol || '-'),
      esc(row.name || row.securityType || '-'),
      esc(row.quantity || '-'),
      row.priceMinor === null ? '<span class="mut">-</span>' : `<span class="num">${money(row.priceMinor, row.currency)}</span>`,
      `<span class="num">${money(row.valueMinor, row.currency)}</span>`,
    ]),
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
  const value = holdings.reduce((sum, item) => sum + Number(item.valueMinor || 0), 0);
  const cash = balances.reduce((sum, item) => sum + Number(item.cashMinor || 0), 0);
  const buyingPower = balances.reduce((sum, item) => sum + Number(item.buyingPowerMinor || 0), 0);
  const cards = el('div', 'cards');
  cards.innerHTML = `
    <div class="card"><div class="lab">Market value</div><div class="big num">${money(value, currency)}</div></div>
    <div class="card"><div class="lab">Cash</div><div class="big num">${money(cash, currency)}</div></div>
    <div class="card"><div class="lab">Buying power</div><div class="big num">${money(buyingPower, currency)}</div></div>
    <div class="card"><div class="lab">Activity</div><div class="big num">${txns.length}</div></div>
  `;
  return cards;
}

function renderCredit() {
  state.section = 'credit';
  activeCreditUpload = null;
  renderSidebar();
  const view = $('#view');
  const actions = el('div', 'row');
  actions.innerHTML = '<button class="primary" type="button" id="openCreditUpload">Upload report</button><button class="ghost" type="button" id="manageCreditReports">Manage reports</button>';
  view.replaceChildren(topbar('Credit Reports', 'Imported from AnnualCreditReport', { action: actions, hideDateRange: true }));
  view.appendChild(renderSubnav(creditTabs, state.creditTab, (tab) => {
    state.creditTab = tab;
    renderCredit();
  }));

  if (state.creditTab === 'reports') renderCreditReportsTab(view);
  else renderLatestCreditReportOverview(view);

  $('#openCreditUpload').addEventListener('click', openCreditUploadModal);
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
        <div class="creditreportmeta">${esc(latest.filename)} · Uploaded ${esc(formatReportDate(latest.createdAt))}${latest.reportDate ? ` · Report date ${esc(formatReportDate(latest.reportDate))}` : ''}</div>
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
    item.innerHTML = `<div class="nm">${esc(row.title)}</div><div class="sub">${esc(row.detail)}</div>`;
    block.appendChild(item);
  }
  if (rows.length > limit) {
    const more = el('div', 'reportminirow moremini');
    more.textContent = `+${rows.length - limit} more`;
    block.appendChild(more);
  }
  return block;
}

function renderCreditOpenAccounts(view) {
  const accounts = state.credit.accounts || [];
  const openAccounts = accounts
    .filter((account) => account.isOpen)
    .map((account) => ({
      title: `${account.creditor}${account.accountMask ? ` ${account.accountMask}` : ''}`,
      detail: accountBalanceSummary(account),
      level: Number(account.pastDueMinor || 0) > 0 || account.isNegative ? 'medium' : '',
    }));
  const section = el('div', 'sec creditdetails');
  section.innerHTML = '<div class="sechdr"><h3>Open accounts</h3><span class="pill">Latest report</span></div>';
  section.appendChild(renderMiniReportList(openAccounts, 'No open accounts parsed.', 8));
  view.appendChild(section);
}

function renderCreditInquiries(view) {
  const inquiries = state.credit.inquiries || [];
  const rows = inquiries
    .map((inquiry) => ({
      title: inquiry.company || 'Unknown company',
      detail: `${inquiry.type === 'hard' ? 'Hard' : 'Soft'} inquiry${inquiry.inquiryDate ? ` · ${formatReportDate(inquiry.inquiryDate)}` : ''}`,
      level: inquiry.type === 'hard' ? 'medium' : '',
    }));
  const section = el('div', 'sec creditdetails');
  section.innerHTML = '<div class="sechdr"><h3>Inquiries</h3><span class="pill">Hard + soft</span></div>';
  section.appendChild(renderMiniReportList(rows, 'No inquiries parsed.', 8));
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
  const reports = state.credit.reports || [];
  const sec = el('div', 'sec creditreports');
  sec.innerHTML = '<div class="sechdr"><h3>Uploaded PDF reports</h3><span class="pill">History</span></div>';
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
        <div class="sub">${esc(report.filename)} · Uploaded ${esc(formatReportDate(report.createdAt))} · ${esc(bytesLabel(report.bytes))}</div>
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

function openCreditUploadModal() {
  const panel = el('div');
  panel.innerHTML = `<div class="sechdr"><h3>Upload credit report</h3><button class="ghost" type="button" id="closeModal">Close</button></div>
    <div class="cardsub">Download your free report from <a href="https://www.annualcreditreport.com/" target="_blank" rel="noreferrer">annualcreditreport.com</a>, then upload the text-searchable PDF here.</div>`;
  const form = el('form', 'formgrid creditform');
  form.innerHTML = '<label class="file-drop compact">Drop PDF or choose file<small id="creditFileName">Experian, Equifax, TransUnion, or annual credit report PDF</small><input name="file" type="file" accept="application/pdf,.pdf"></label><span class="message" id="creditMessage"></span><div class="uploadhistory" id="creditUploadHistory"></div>';
  panel.appendChild(form);
  modal(panel);
  $('#closeModal').addEventListener('click', closeModal);

  const fileInput = form.elements.file;
  const dropzone = form.querySelector('.file-drop');
  const uploadFile = async (file) => {
    const message = $('#creditMessage');
    const history = $('#creditUploadHistory');
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
    $('#creditFileName').textContent = file?.name || 'Experian, Equifax, TransUnion, or annual credit report PDF';
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
    $('#creditFileName').textContent = file.name;
    uploadFile(file);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });
}

function openCreditManageModal() {
  const reports = state.credit.reports || [];
  const panel = el('div');
  panel.innerHTML = `<div class="sechdr"><h3>Manage reports</h3><button class="ghost" type="button" id="closeModal">Close</button></div>
    <p class="cardsub">Review uploaded credit report PDFs and remove reports you no longer want Finora to keep.</p>`;
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
  panel.appendChild(list);
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
  const createButton = el('button', 'primary');
  createButton.type = 'button';
  createButton.id = 'openChartCreator';
  createButton.textContent = 'Create chart';
  view.replaceChildren(topbar('Dashboards', 'Saved views', { hideDateRange: true, action: createButton }));
  $('#openChartCreator').addEventListener('click', openChartModal);
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
    sec.innerHTML = `<div class="sechdr"><h3>${esc(dashboard.name)}</h3><div class="row"><span class="pill">${artifactCount} artifact${artifactCount === 1 ? '' : 's'}</span>${artifactCount ? '<button class="ghost danger dashboarddelete" type="button">Delete dashboard</button>' : ''}</div></div>`;
    const dashboardDelete = sec.querySelector('.dashboarddelete');
    if (dashboardDelete) {
      dashboardDelete.addEventListener('click', () => {
        for (const artifact of visibleArtifacts) {
          const id = artifact.publicId || artifact.id;
          if (isCustomArtifact(artifact)) removeCustomDashboardArtifact(id);
          else hideDashboardArtifact(id);
        }
        toast('Dashboard deleted.');
        renderDashboards();
      });
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
      slot.style.margin = '0';
      const span = Number(item.w || item.width || 6);
      slot.style.gridColumn = `span ${Math.min(12, Math.max(3, span))}`;
      const actions = el('div', 'dashactions');
      if (isCustomArtifact(saved)) {
        const edit = el('button', 'iconbtn');
        edit.type = 'button';
        edit.textContent = 'Edit';
        edit.title = 'Edit chart';
        edit.addEventListener('click', () => openChartModal(saved));
        actions.appendChild(edit);
      }
      const remove = el('button', 'iconbtn danger');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.title = isCustomArtifact(saved) ? 'Delete chart' : 'Hide widget';
      remove.addEventListener('click', () => {
        const id = saved.publicId || saved.id;
        if (isCustomArtifact(saved)) removeCustomDashboardArtifact(id);
        else hideDashboardArtifact(id);
        toast(isCustomArtifact(saved) ? 'Chart deleted.' : 'Widget hidden.');
        renderDashboards();
      });
      actions.appendChild(remove);
      slot.appendChild(actions);
      const host = el('div');
      slot.appendChild(host);
      grid.appendChild(slot);
      renderArtifactChart(host, saved);
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
    closeModal();
    toast(editing ? 'Chart updated.' : 'Chart saved.');
    renderDashboards();
  });
}

function renderSettings() {
  const view = $('#view');
  const action = state.settingsTab === 'insights' ? el('button', 'primary') : null;
  if (action) {
    action.type = 'button';
    action.id = 'newRuleTopbar';
    action.textContent = 'Create alert';
  }
  view.replaceChildren(topbar('Settings', 'Local runtime', { hideDateRange: true, action }));
  if (action) action.addEventListener('click', () => openRuleModal());
  const nav = el('div', 'subnav');
  for (const [id, label] of settingsTabs) {
    const tab = el('div', `subtab${state.settingsTab === id ? ' active' : ''}`);
    tab.textContent = label;
    tab.addEventListener('click', () => {
      state.settingsTab = id;
      renderSettings();
    });
    nav.appendChild(tab);
  }
  view.appendChild(nav);

  if (state.settingsTab === 'models') return renderSettingsModels(view);
  if (state.settingsTab === 'banks') return renderSettingsBanks(view);
  if (state.settingsTab === 'brokerage') return renderSettingsBrokerage(view);
  if (state.settingsTab === 'notifications') return renderSettingsNotifications(view);
  return renderSettingsInsights(view);
}

function settingRow(key, label, type = 'text') {
  const current = setting(key);
  return `<label>${esc(label)}<input name="${esc(key)}" type="${esc(type)}" placeholder="${current.set ? esc(current.preview) : 'Not set'}" autocomplete="off"></label>`;
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

function providerCredentialGuide(provider) {
  const guide = el('div', 'settingsguide');
  if (provider === 'plaid') {
    guide.innerHTML = '<div class="nm">How to get Plaid credentials</div><ol><li>Open the Plaid Dashboard and choose the app/environment you want Finora to use.</li><li>Go to Team Settings or API keys, then copy the Client ID.</li><li>Copy the Secret for the same environment. Use sandbox credentials while testing.</li><li>Save both values here before opening Plaid Link.</li></ol>';
  } else {
    guide.innerHTML = '<div class="nm">How to get SnapTrade credentials</div><ol><li>Open your SnapTrade partner/developer dashboard.</li><li>Copy the Client ID and Consumer Key for this application.</li><li>Save both values here. Finora should create or reuse the per-user SnapTrade credentials internally when opening the Connection Portal.</li><li>Brokerage connections should be requested read-only.</li></ol>';
  }
  return guide;
}

function renderSettingsModels(view) {
  const effective = state.llm?.effective || {};
  const providers = state.llm?.providers || [];
  const providerOptions = providers.map((provider) =>
    `<option value="${esc(provider.id)}"${provider.id === effective.provider ? ' selected' : ''}>${esc(provider.label)}</option>`
  ).join('');
  const formSection = settingsForm(
    'Language model',
    `Web chat and Telegram use the same configured model. Current route: ${esc(effective.label || 'not configured')} / ${esc(effective.chatModel || 'no chat model')}.`,
    [
      `<label>Provider<select name="LLM_PROVIDER">${providerOptions}</select></label>`,
      settingRow('LLM_API_KEY', 'API key', 'password'),
      settingRow('LLM_BASE_URL', 'Base URL'),
      settingRow('LLM_MODEL', 'Extraction model'),
      settingRow('LLM_CHAT_MODEL', 'Chat model'),
    ],
  );
  const actions = formSection.querySelector('.row');
  const test = el('button', 'ghost');
  test.type = 'button';
  test.textContent = 'Test model';
  const status = el('span', 'message');
  test.addEventListener('click', async () => {
    test.disabled = true;
    status.textContent = 'Testing...';
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

function renderSettingsBanks(view) {
  const hasCredentials = settingIsSet('PLAID_CLIENT_ID') && settingIsSet('PLAID_SECRET');
  const form = settingsForm(
    'Plaid API settings',
    hasCredentials
      ? 'Plaid credentials are saved. The local Link/token-exchange connector endpoint is still not implemented in this build.'
      : 'Save the app-level Plaid credentials used to create a Link token. Bank login and MFA should happen only inside Plaid Link.',
    [
      settingRow('PLAID_CLIENT_ID', 'Plaid client ID'),
      settingRow('PLAID_SECRET', 'Plaid secret', 'password'),
    ],
  );
  form.appendChild(providerCredentialGuide('plaid'));
  view.appendChild(form);
  renderAccountManager(view, 'plaid', providerManagedAccounts('plaid', bankAccounts()));
}

function renderSettingsBrokerage(view) {
  const form = settingsForm(
    'SnapTrade API settings',
    'Save the app-level SnapTrade credentials used to create a read-only Connection Portal session.',
    [
      settingRow('SNAPTRADE_CLIENT_ID', 'SnapTrade client ID'),
      settingRow('SNAPTRADE_CONSUMER_KEY', 'SnapTrade consumer key', 'password'),
    ],
  );
  form.appendChild(providerCredentialGuide('snaptrade'));
  view.appendChild(form);
  renderAccountManager(view, 'snaptrade', providerManagedAccounts('snaptrade', brokerageAccounts()));
}

function renderSettingsNotifications(view) {
  const sec = el('div', 'sec notificationpanel');
  sec.innerHTML = '<div class="sechdr"><h3>Notifications</h3></div><div class="cardsub">Choose where alerts and generated insights are delivered. The Insights feed always stays local; notification channels are only for pushed items.</div>';
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

function renderSettingsInsights(view) {
  const feedItems = buildFeedItems();
  const sec = el('div', 'sec');
  sec.innerHTML = '<div class="sechdr"><h3>Rules</h3></div><div class="cardsub">Rules can run on events or on a schedule. Use the switch to pause delivery without changing the rule.</div>';
  const box = el('div', 'rulelist');
  const rules = [
    ...builtInRules().map((rule) => ({
      ...rule,
      builtIn: true,
      sourceText: rule.name,
      title: rule.name,
      description: rule.detail,
      status: builtInRuleCurrent(rule.originalName, feedItems),
      editable: true,
      removable: true,
      toggle: () => {
        saveBuiltInRuleOverride(rule.originalName, { ...rule, enabled: !rule.enabled });
        toast(rule.enabled ? 'Rule disabled.' : 'Rule enabled.');
        renderSettings();
      },
      remove: () => {
        saveBuiltInRuleOverride(rule.originalName, { ...rule, deleted: true, enabled: false });
        toast('Rule deleted.');
        renderSettings();
      },
    })),
    ...state.alertRules.map((rule) => ({
      ...rule,
      title: rule.sourceText,
      description: '',
      status: 'Ready',
      editable: true,
      removable: true,
      toggle: async () => {
        await api('/v1/alert-rules/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: rule.id, enabled: !rule.enabled }),
        });
        await loadData();
        renderSettings();
      },
      remove: async () => {
        await api('/v1/alert-rules/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: rule.id }),
        });
        await loadData();
        renderSettings();
      },
    })),
  ];
  for (const rule of rules) box.appendChild(ruleRow(rule));
  sec.appendChild(box);
  view.appendChild(sec);

  const muted = el('div', 'sec');
  muted.innerHTML = '<div class="sechdr"><h3>Muted</h3><span class="pill">' + state.alertMutes.length + '</span></div>';
  muted.appendChild(state.alertMutes.length ? transactionLikeTable(
    ['Mute', 'Expires', 'Created'],
    state.alertMutes.map((mute) => [
      esc(mute.label || mute.kind || mute.accountId || 'Mute'),
      esc(mute.expiresAt || 'Permanent'),
      esc(mute.createdAt),
    ]),
    { pageKey: 'settings-muted' },
  ) : empty('Nothing muted.'));
  view.appendChild(muted);
}

function ruleRow(rule) {
  const row = el('div', `rulerow${rule.enabled ? '' : ' muted'}`);
  const copy = el('div', 'rulecopy');
  copy.innerHTML = `<div class="nm">${esc(rule.title)}</div><div class="ruletags">${ruleTags(rule)}</div>${rule.description ? `<div class="sub">${esc(rule.description)}</div>` : ''}`;
  const actions = el('div', 'ruleactions');
  actions.appendChild(ruleToggle(rule));
  if (rule.editable) {
    const edit = el('button', 'ghost');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openRuleModal(rule));
    actions.appendChild(edit);
  }
  if (rule.removable) {
    const remove = el('button', 'ghost danger');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', rule.remove);
    actions.appendChild(remove);
  }
  row.append(copy, actions);
  return row;
}

function ruleTags(rule) {
  return [
    ruleTag('scope', rule.scope),
    ruleTag('cadence', rule.cadence),
    rule.channel ? ruleTag('channel', rule.channel) : '',
    ruleTag('hour', ruleHourLabel(rule)),
    rule.status ? ruleTag('status', rule.status) : '',
  ].filter(Boolean).join('');
}

function ruleTag(kind, value) {
  return `<span class="ruletag ${esc(kind)}">${esc(value)}</span>`;
}

function ruleHourLabel(rule) {
  if (rule.scheduledHour === null || rule.scheduledHour === undefined) return 'no fixed hour';
  return `${String(rule.scheduledHour).padStart(2, '0')}:00`;
}

function ruleToggle(rule) {
  const button = el('button', `switchbtn${rule.enabled ? ' on' : ''}`);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(Boolean(rule.enabled)));
  button.setAttribute('aria-label', `${rule.enabled ? 'Disable' : 'Enable'} ${rule.title}`);
  button.innerHTML = `<span></span><b>${rule.enabled ? 'On' : 'Off'}</b>`;
  button.addEventListener('click', rule.toggle);
  return button;
}

function builtInRuleOverrides() {
  try {
    const raw = JSON.parse(localStorage.getItem(builtInRulesKey) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveBuiltInRuleOverride(originalName, patch) {
  const overrides = builtInRuleOverrides();
  overrides[originalName] = {
    name: patch.name,
    cadence: patch.cadence,
    scope: patch.scope,
    channel: patch.channel || 'auto',
    mode: patch.mode,
    scheduledHour: patch.scheduledHour ?? null,
    detail: patch.detail,
    enabled: patch.enabled,
    deleted: patch.deleted === true,
  };
  localStorage.setItem(builtInRulesKey, JSON.stringify(overrides));
}

function builtInRules() {
  const overrides = builtInRuleOverrides();
  return sampleInsightRules.flatMap(([name, cadence, scope, mode, scheduledHour, detail]) => {
    const saved = overrides[name] || {};
    if (saved.deleted === true) return [];
    return {
      originalName: name,
      name: saved.name || name,
      cadence: saved.cadence || cadence,
      scope: saved.scope || scope,
      channel: saved.channel || 'auto',
      mode: saved.mode || mode,
      scheduledHour: saved.scheduledHour ?? scheduledHour,
      detail: saved.detail || detail,
      enabled: saved.enabled !== false,
    };
  });
}

function builtInRuleCurrent(name, feedItems) {
  const connectionIssues = state.connections.filter((item) => item.status !== 'active' || !item.hasAccessToken || (item.provider === 'plaid' && !item.hasCursor)).length;
  const outflows = selectedTransactions().filter((txn) => txn.amountMinor < 0);
  const largeOutflows = outflows.filter((txn) => Math.abs(txn.amountMinor) >= 50000).length;
  if (name === 'Connection health') return `${connectionIssues} open`;
  if (name === 'New large transaction') return `${largeOutflows} rows`;
  if (name === 'Brokerage cash drag') return `${feedItems.filter((item) => /cash/i.test(item.title)).length} open`;
  if (name === 'Portfolio concentration') return `${feedItems.filter((item) => item.group === 'Portfolio').length} open`;
  if (name === 'Credit utilization') return `${state.accounts.filter((item) => item.type === 'credit').length} cards`;
  if (name === 'Net worth movement') return `${state.balances.length} balances`;
  if (name === 'Weekly financial health check') return `${feedItems.length} signals`;
  return 'Ready';
}

function openRuleModal(existingRule = null) {
  const panel = el('div');
  panel.innerHTML = `<div class="sechdr"><h3>${existingRule ? 'Edit alert' : 'Create alert'}</h3><button class="ghost" type="button" id="closeModal">Close</button></div>`;
  const form = el('form', 'formgrid generaterule');
  const hasPreview = Boolean(existingRule);
  form.innerHTML = `<label>Rule prompt<textarea name="text" required placeholder="Generate a weekly rule that flags brokerage cash above 25% and explains why it matters.">${esc(existingRule?.sourceText || '')}</textarea></label>
    <div class="row"><button class="ghost" type="button" id="previewRule">Preview</button><span class="message"></span></div>
    <div class="rulepreview" id="rulePreview"${existingRule ? '' : ' hidden'}>${existingRule ? rulePreviewMarkup(existingRule) : ''}</div>
    <div class="deliverysettings" id="deliverySettings"${hasPreview ? '' : ' hidden'}><div class="nm">Delivery settings</div><div class="split"><label>Scope<select name="scope"><option value="">Generate</option><option${existingRule?.scope === 'banking' ? ' selected' : ''}>banking</option><option${existingRule?.scope === 'brokerage' ? ' selected' : ''}>brokerage</option><option${existingRule?.scope === 'credit' ? ' selected' : ''}>credit</option><option${existingRule?.scope === 'all' ? ' selected' : ''}>all</option></select></label><label>Cadence<select name="cadence"><option value="">Generate</option><option${existingRule?.cadence === 'event' ? ' selected' : ''}>event</option><option${existingRule?.cadence === 'hourly' ? ' selected' : ''}>hourly</option><option${existingRule?.cadence === 'daily' ? ' selected' : ''}>daily</option><option${existingRule?.cadence === 'weekly' ? ' selected' : ''}>weekly</option><option${existingRule?.cadence === 'monthly' ? ' selected' : ''}>monthly</option></select></label></div><div class="split"><label>Channel<select name="channel"><option${existingRule?.channel === 'auto' ? ' selected' : ''}>auto</option><option${existingRule?.channel === 'digest' ? ' selected' : ''}>digest</option><option${existingRule?.channel === 'telegram' ? ' selected' : ''}>telegram</option><option${existingRule?.channel === 'slack' ? ' selected' : ''}>slack</option></select></label><label>Run hour<select name="scheduledHour">${ruleHourOptions(existingRule?.scheduledHour)}</select></label></div></div>
    <div class="row"><button class="primary" type="submit" id="saveRule"${hasPreview ? '' : ' hidden disabled'}>Save rule</button></div>`;
  panel.appendChild(form);
  modal(panel);
  $('#closeModal').addEventListener('click', closeModal);
  form.elements.text.addEventListener('input', () => {
    if (existingRule) return;
    $('#deliverySettings').hidden = true;
    $('#saveRule').hidden = true;
    $('#saveRule').disabled = true;
    $('#rulePreview').hidden = true;
    $('#rulePreview').innerHTML = '';
  });
  $('#previewRule').addEventListener('click', async () => {
    const data = ruleFormData(form);
    const button = $('#previewRule');
    button.disabled = true;
    form.querySelector('.message').textContent = 'Inferring settings...';
    form.querySelector('.message').classList.remove('error');
    try {
      const preview = await api('/v1/alert-rules/preview', {
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
    const data = ruleFormData(form);
    const submit = event.submitter;
    submit.disabled = true;
    try {
      if (existingRule?.builtIn) {
        saveBuiltInRuleOverride(existingRule.originalName, {
          ...existingRule,
          name: data.text,
          scope: data.scope || existingRule.scope,
          cadence: data.cadence || existingRule.cadence,
          channel: data.channel || existingRule.channel || 'auto',
          scheduledHour: data.scheduledHour,
          enabled: existingRule.enabled !== false,
        });
        closeModal();
        toast('Rule saved.');
        renderSettings();
        return;
      }
      const savedRule = await api('/v1/alert-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (existingRule && existingRule.enabled === false) {
        await api('/v1/alert-rules/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: savedRule.id, enabled: false }),
        });
      }
      if (existingRule) {
        await api('/v1/alert-rules/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: existingRule.id }),
        });
      }
      await loadData();
      closeModal();
      toast(existingRule ? 'Generated rule saved.' : 'Generated rule created.');
      renderSettings();
    } catch (error) {
      form.querySelector('.message').textContent = error.message;
      form.querySelector('.message').classList.add('error');
    } finally {
      submit.disabled = false;
    }
  });
}

function ruleFormData(form) {
  const data = Object.fromEntries(new FormData(form));
  for (const key of ['scope', 'cadence']) if (!data[key]) delete data[key];
  data.scheduledHour = data.scheduledHour === '' ? null : Number(data.scheduledHour);
  return data;
}

function applyRulePreview(form, preview) {
  form.elements.scope.value = preview.scope;
  form.elements.cadence.value = preview.cadence;
  form.elements.channel.value = preview.channel;
  form.elements.scheduledHour.value = preview.scheduledHour === null || preview.scheduledHour === undefined ? '' : String(preview.scheduledHour);
}

function rulePreviewMarkup(rule) {
  const source = rule.inference?.source === 'llm' ? `LLM: ${rule.inference.model}` : 'Heuristic fallback';
  return `<div class="rulepreviewgrid">
    <div><span>Scope</span><b>${esc(rule.scope)}</b></div>
    <div><span>Cadence</span><b>${esc(rule.cadence)}</b></div>
    <div><span>Channel</span><b>${esc(rule.channel)}</b></div>
    <div><span>Run hour</span><b>${esc(ruleHourLabel(rule))}</b></div>
  </div>
  <div class="ruletags">${ruleTag('status', rule.mode || 'rule')} ${ruleTag('status', source)}</div>
  ${rule.strategy ? `<div class="sub">${esc(rule.strategy)}</div>` : ''}`;
}

function ruleHourOptions(selected) {
  const current = selected === null || selected === undefined ? '' : String(selected);
  const options = ['<option value="">No fixed hour</option>'];
  for (let hour = 0; hour < 24; hour += 1) {
    const value = String(hour);
    options.push(`<option value="${value}"${current === value ? ' selected' : ''}>${String(hour).padStart(2, '0')}:00</option>`);
  }
  return options.join('');
}

function renderProviderOverview(view, provider, accounts) {
  const copy = connectorCopy[provider];
  const summary = providerSummary(provider, accounts);
  const hasCredentials = provider === 'plaid'
    ? settingIsSet('PLAID_CLIENT_ID') && settingIsSet('PLAID_SECRET')
    : settingIsSet('SNAPTRADE_CLIENT_ID') && settingIsSet('SNAPTRADE_CONSUMER_KEY');
  const sec = el('div', 'sec provider-overview');
  sec.innerHTML = `<div class="sechdr"><h3>${esc(copy.title)}</h3><span class="status ${summary.active ? 'ok' : 'off'}">${esc(summary.status)}</span></div>
    <div class="cardsub">${esc(copy.connectedText)}</div>`;
  const grid = el('div', 'statusgrid');
  const metrics = [
    [copy.sourceLabel, summary.source],
    ['Active connections', String(summary.active)],
    ['Needs review', String(summary.needsReview)],
    ['Managed accounts', String(summary.accounts)],
    ['Accepting new transactions', summary.canSync ? 'Ready for saved connection' : 'No active sync path'],
    ['API credentials', hasCredentials ? 'Saved' : 'Missing'],
  ];
  for (const [label, value] of metrics) {
    const card = el('div', 'statuscell');
    card.innerHTML = `<div class="lab">${esc(label)}</div><div class="value">${esc(value)}</div>`;
    grid.appendChild(card);
  }
  sec.appendChild(grid);
  const note = el('div', 'callout');
  note.innerHTML = `<b>${hasCredentials ? 'Connector status' : 'Current limitation'}</b><span>${esc(hasCredentials ? `${copy.limitation} Credentials are saved locally.` : copy.limitation)}</span>`;
  sec.appendChild(note);
  view.appendChild(sec);
}

function notificationChannelCard(id, title, rows, detail) {
  const connected = rows.every(([key]) => settingIsSet(key));
  const card = el('div', 'channelcard');
  card.innerHTML = `<div class="channelhead"><div><div class="nm">${esc(title)}</div><div class="sub">${esc(detail)}</div></div><span class="status ${connected ? 'ok' : 'off'}">${connected ? 'Connected' : 'Not connected'}</span></div>`;
  const steps = el('div', 'steplist');
  rows.forEach(([key, label, instruction], index) => {
    const row = el('div', 'steprow');
    row.innerHTML = `<span class="stepnum">${index + 1}</span><div><div class="nm">${esc(label)} <span class="mut">(${settingIsSet(key) ? 'saved' : 'missing'})</span></div><div class="sub">${esc(instruction)}</div></div>`;
    steps.appendChild(row);
  });
  card.appendChild(steps);
  return card;
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

async function openSnapTradePortal() {
  const { url } = await api('/v1/snaptrade/connect', { method: 'POST' });
  if (!url) throw new Error('SnapTrade did not return a portal URL.');
  const width = Math.min(520, Math.max(360, Math.floor(window.screen.availWidth * 0.9)));
  const height = Math.min(760, Math.max(560, Math.floor(window.screen.availHeight * 0.9)));
  const left = Math.max(0, Math.floor((window.screen.availWidth - width) / 2));
  const top = Math.max(0, Math.floor((window.screen.availHeight - height) / 2));
  const features = [
    'popup=yes',
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'resizable=yes',
    'scrollbars=yes',
  ].join(',');
  const popup = window.open(url, 'finora-snaptrade-connect', features);
  if (!popup) {
    window.location.href = url;
    return;
  }
  popup.focus();
}

async function openProviderConnection(provider) {
  try {
    if (provider === 'snaptrade') await openSnapTradePortal();
    else await openPlaidLink();
  } catch (error) {
    toast(error.message);
  }
}

function providerDeleteCopy(account) {
  if (account.source === 'plaid') {
    return {
      provider: 'plaid',
      title: 'Remove Plaid bank',
      connectionId: account.metadata?.plaidItemId || account.metadata?.itemId || account.metadata?.item_id || account.providerAccountId,
      endpoint: '/v1/plaid/remove',
      idField: 'item_id',
      message: 'Plaid accounts are removed at the bank connection level, not one local account row at a time.',
    };
  }
  if (account.source === 'snaptrade') {
    return {
      provider: 'snaptrade',
      title: 'Remove SnapTrade connection',
      connectionId: account.metadata?.authorizationId || account.metadata?.authorization_id || account.metadata?.connectionId || account.providerAccountId,
      endpoint: '/v1/snaptrade/remove',
      idField: 'authorization_id',
      message: 'SnapTrade accounts are removed at the brokerage connection level, not one local account row at a time.',
    };
  }
  return null;
}

function providerConnectionAccounts(account, providerDelete) {
  return state.accounts.filter((item) => {
    if (item.source !== account.source) return false;
    const other = providerDeleteCopy(item);
    if (providerDelete.connectionId && other?.connectionId) return other.connectionId === providerDelete.connectionId;
    return item.institution === account.institution;
  });
}

function openProviderRemoveModal(account, providerDelete) {
  const related = providerConnectionAccounts(account, providerDelete);
  const panel = el('div');
  panel.innerHTML = `<div class="sechdr"><h3>${esc(providerDelete.title)}</h3><button class="ghost" type="button" id="closeModal">Close</button></div>
    <div class="cardsub">${esc(providerDelete.message)} Provider-managed accounts are unlinked through Plaid or SnapTrade so the next sync cannot recreate stale local rows.</div>`;
  const list = el('div', 'accountlist');
  for (const item of related) {
    const row = el('div', 'accountrow');
    const type = String(item.type || 'account').replaceAll('_', ' ');
    row.innerHTML = `<div><div class="nm">${esc(item.name)}</div><div class="sub">${esc(item.institution)} - ${esc(type)} - ${esc(item.currency)}</div></div>`;
    list.appendChild(row);
  }
  const form = el('form', 'formgrid');
  form.innerHTML = `<div class="message" id="modalMessage">This connector endpoint is not wired yet.</div>
    <div class="row"><button class="ghost danger" type="submit">Remove connection</button></div>`;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('#modalMessage');
    const submit = event.submitter;
    submit.disabled = true;
    try {
      if (!providerDelete.connectionId) throw new Error('No provider connection id is available for this account.');
      await api(providerDelete.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [providerDelete.idField]: providerDelete.connectionId }),
      });
      await loadData();
      closeModal();
      toast('Connection removed.');
      renderSettings();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add('error');
    } finally {
      submit.disabled = false;
    }
  });
  panel.append(list, form);
  modal(panel);
  $('#closeModal').addEventListener('click', closeModal);
}

function renderAccountManager(view, provider, accounts) {
  const isBrokerage = provider === 'snaptrade';
  const sec = el('div', 'sec');
  sec.innerHTML = `<div class="sechdr"><h3>Manage accounts</h3><button class="primary" type="button">${isBrokerage ? 'Add brokerage account' : 'Add bank account'}</button></div>`;
  const add = sec.querySelector('button');
  add.addEventListener('click', () => openProviderConnection(provider));

  if (!accounts.length) {
    sec.appendChild(empty(`No ${isBrokerage ? 'brokerage' : 'banking'} accounts yet.`));
    view.appendChild(sec);
    return;
  }

  const list = el('div', 'accountlist');
  for (const item of accounts) {
    const row = el('div', 'accountrow');
    const type = String(item.type || 'account').replaceAll('_', ' ');
    row.innerHTML = `<div><div class="nm">${esc(item.name)}</div><div class="sub">${esc(item.institution)} - ${esc(type)} - ${esc(item.currency)}</div></div>`;
    const actions = el('div', 'row');
    const providerDelete = providerDeleteCopy(item);
    const remove = el('button', 'ghost danger');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (providerDelete) {
        openProviderRemoveModal(item, providerDelete);
        return;
      }
      if (!window.confirm(`Remove ${item.institution} - ${item.name}?\n\nThis permanently removes this local account and its local rows. Provider-managed accounts must be removed through Plaid or SnapTrade.`)) return;
      await api(`/v1/accounts/${item.id}`, { method: 'DELETE' });
      if (state.accountId === item.id) state.accountId = null;
      await loadData();
      toast('Account removed.');
      renderSettings();
    });
    actions.append(remove);
    row.appendChild(actions);
    list.appendChild(row);
  }
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

function openImportModal() {
  const panel = el('div');
  panel.innerHTML = '<div class="sechdr"><h3>Import statement</h3><button class="ghost" type="button" id="closeModal">Close</button></div>';
  const form = el('form', 'formgrid');
  form.innerHTML = `<label>Account<select name="accountId" required><option value="">Choose an account</option>${bankAccounts().map((item) => `<option value="${esc(item.id)}">${esc(item.institution)} - ${esc(item.name)}</option>`).join('')}</select></label>
    <label class="file-drop">Choose statement<small id="fileName">CSV, OFX, or QFX</small><input name="file" type="file" accept=".csv,.ofx,.qfx,text/csv" required></label>
    <div class="row"><button class="primary" type="submit">Import</button><button class="ghost" type="button" id="newAccountFromImport">New account</button></div>
    <div class="message" id="modalMessage"></div>`;
  panel.appendChild(form);
  modal(panel);
  $('#closeModal').addEventListener('click', closeModal);
  $('#newAccountFromImport').addEventListener('click', openAccountModal);
  const fileInput = form.elements.file;
  fileInput.addEventListener('change', () => {
    $('#fileName').textContent = fileInput.files[0]?.name || 'CSV, OFX, or QFX';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('#modalMessage');
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const file = fileInput.files[0];
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      const result = await api('/v1/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: form.elements.accountId.value,
          filename: file.name,
          format: 'auto',
          contentBase64: btoa(binary),
        }),
      });
      await loadData();
      closeModal();
      toast(`Imported ${result.insertedCount}; skipped ${result.skippedCount}.`);
      render();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add('error');
    } finally {
      submit.disabled = false;
    }
  });
}

function openAccountModal(defaultType = 'Checking') {
  const panel = el('div');
  panel.innerHTML = '<div class="sechdr"><h3>Create account</h3><button class="ghost" type="button" id="closeModal">Close</button></div>';
  const form = el('form', 'formgrid');
  form.innerHTML = `<label>Institution<input name="institution" autocomplete="organization" required></label>
    <label>Account name<input name="name" required></label>
    <div class="split"><label>Type<select name="type"><option>Checking</option><option>Savings</option><option>Credit Card</option><option>Brokerage</option><option>Other</option></select></label><label>Currency<input name="currency" value="USD" maxlength="3" required></label></div>
    <button class="primary" type="submit">Create account</button>
    <div class="message" id="modalMessage"></div>`;
  panel.appendChild(form);
  modal(panel);
  form.elements.type.value = defaultType;
  $('#closeModal').addEventListener('click', closeModal);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      data.type = String(data.type).toLowerCase().replaceAll(' ', '_');
      data.currency = String(data.currency).toUpperCase();
      data.domain = data.type === 'brokerage' ? 'brokerage' : 'bank';
      data.source = 'manual';
      await api('/v1/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      await loadData();
      closeModal();
      toast('Account created.');
      render();
    } catch (error) {
      $('#modalMessage').textContent = error.message;
      $('#modalMessage').classList.add('error');
    } finally {
      submit.disabled = false;
    }
  });
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
        messages: thread.messages
          .filter((msg) => msg.content !== pendingChatContent)
          .slice(-10)
          .map((msg) => ({ role: msg.role, content: msg.content })),
      }),
    });
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
  $('#contextBar').textContent = state.section === 'banks' ? `Context: Banking${account(state.accountId) ? ` / ${account(state.accountId).name}` : ''}` : `Context: ${sections.find((item) => item.id === state.section)?.label || 'Finora'}`;
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
