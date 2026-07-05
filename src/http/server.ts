import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { FinanceService } from '../application/finance-service.js';
import { AppError } from '../application/errors.js';
import { openApiDocument } from './openapi.js';

const accountSchema = z.object({
  institution: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  type: z.string().trim().min(1).max(60).default('checking'),
  currency: z.string().trim().length(3).default('USD'),
  domain: z.enum(['bank', 'brokerage']).optional(),
  source: z.string().trim().min(1).max(60).optional(),
  providerAccountId: z.string().trim().min(1).max(255).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const importSchema = z.object({
  accountId: z.string().uuid(),
  filename: z.string().trim().min(1).max(255),
  format: z.enum(['auto', 'csv', 'ofx']).default('auto'),
  contentBase64: z.string().min(1),
}).strict();

const creditReportImportSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentBase64: z.string().min(1),
}).strict();

const disputeLetterSchema = z.object({
  creditor: z.string().trim().min(1).max(180),
  accountMask: z.string().trim().max(40).nullable().optional(),
  reason: z.string().trim().min(1).max(2000),
  bureau: z.string().trim().max(40).optional(),
}).strict();

const settingsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const plaidExchangeSchema = z.object({
  public_token: z.string().trim().min(1),
}).strict();

const plaidUpdateSchema = z.object({
  item_id: z.string().trim().min(1),
  accounts: z.boolean().optional(),
}).strict();

const snaptradeRemoveSchema = z.object({
  authorization_id: z.string().trim().min(1),
}).strict();

const chatSchema = z.object({
  section: z.string().trim().max(60).optional(),
  contextAttachments: z.array(z.object({
    id: z.string().trim().max(80),
    type: z.enum(['chart', 'table']),
    title: z.string().trim().max(160),
    section: z.string().trim().max(60).optional(),
    totalRows: z.number().int().min(0).max(100000).optional(),
    columns: z.array(z.string().trim().max(80)).max(20).optional(),
    rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(100).optional(),
    artifact: z.unknown().optional(),
    note: z.string().trim().max(500).optional(),
  }).strict()).max(6).optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(8000),
  }).strict()).min(1).max(20),
}).strict();

const ruleCreateSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  scope: z.string().trim().max(40).optional(),
  cadence: z.string().trim().max(40).optional(),
  channel: z.string().trim().max(40).optional(),
  scheduledHour: z.number().int().min(0).max(23).nullable().optional(),
}).strict();

const ruleToggleSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
}).strict();

const ruleRemoveSchema = z.object({
  id: z.string().uuid(),
}).strict();

const insightMuteCreateSchema = z.object({
  kind: z.string().trim().max(120).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  label: z.string().trim().max(160).nullable().optional(),
  days: z.number().int().min(0).max(365).nullable().optional(),
}).strict();

export interface ServerOptions {
  host: string;
  port: number;
  desktopToken?: string;
  onDesktopShutdown?: () => void;
}

export function startHttpServer(service: FinanceService, options: ServerOptions) {
  service.startBackgroundServices();
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    setSecurityHeaders(response, requestId);
    try {
      await route(service, request, response, options);
    } catch (error) {
      sendError(response, error, requestId);
    }
  });
  server.listen(options.port, options.host, () => {
    console.log(`Finora is listening at http://${options.host}:${options.port}`);
  });
  return server;
}

async function route(
  service: FinanceService,
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
) {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');

  if ((method === 'GET' || method === 'HEAD') && !url.pathname.startsWith('/v1/') && url.pathname !== '/openapi.json') {
    return sendAsset(response, url.pathname, method === 'HEAD');
  }
  if (method === 'GET' && url.pathname === '/openapi.json') return sendJson(response, 200, openApiDocument);
  if (method === 'GET' && url.pathname === '/v1/health') {
    return sendJson(response, 200, { status: 'ok', version: '0.1.0' });
  }
  if (
    url.pathname.startsWith('/v1/') &&
    options.desktopToken &&
    request.headers['x-finora-desktop-token'] !== options.desktopToken
  ) {
    throw new HttpError(401, 'unauthorized', 'A valid desktop session is required');
  }
  if (
    method === 'POST' &&
    url.pathname === '/v1/desktop/shutdown' &&
    options.onDesktopShutdown
  ) {
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
    setImmediate(options.onDesktopShutdown);
    return;
  }
  if (url.pathname === '/v1/accounts' && method === 'GET') {
    return sendJson(response, 200, { items: service.listAccounts() });
  }
  if (url.pathname === '/v1/accounts' && method === 'POST') {
    const input = parseSchema(accountSchema, await readJson(request));
    const account = service.createAccount(input);
    response.setHeader('Location', `/v1/accounts/${account.id}`);
    return sendJson(response, 201, account);
  }
  const accountMatch = /^\/v1\/accounts\/([0-9a-f-]+)$/i.exec(url.pathname);
  if (accountMatch && method === 'GET') {
    return sendJson(response, 200, service.getAccount(accountMatch[1]!));
  }
  if (accountMatch && method === 'DELETE') {
    return sendJson(response, 200, service.removeAccount(accountMatch[1]!));
  }
  if (url.pathname === '/v1/imports' && method === 'POST') {
    const input = parseSchema(importSchema, await readJson(request, 28 * 1024 * 1024));
    let content: Buffer;
    try {
      content = Buffer.from(input.contentBase64, 'base64');
    } catch {
      throw new AppError('invalid_input', 'contentBase64 is invalid');
    }
    if (content.byteLength > 20 * 1024 * 1024) {
      throw new AppError('invalid_input', 'Decoded statement exceeds the 20 MB limit');
    }
    const result = service.importStatement({
      accountId: input.accountId,
      filename: input.filename,
      format: input.format,
      content,
    });
    await service.deliverInsightsToIm();
    return sendJson(response, 200, result);
  }
  if (url.pathname === '/v1/credit-reports' && method === 'POST') {
    const input = parseSchema(creditReportImportSchema, await readJson(request, 30 * 1024 * 1024));
    let content: Buffer;
    try {
      content = Buffer.from(input.contentBase64, 'base64');
    } catch {
      throw new AppError('invalid_input', 'contentBase64 is invalid');
    }
    if (content.byteLength > 25 * 1024 * 1024) {
      throw new AppError('invalid_input', 'Credit report PDF exceeds the 25 MB limit');
    }
    return sendJson(response, 200, await service.importCreditReport({ filename: input.filename, content }));
  }
  if (url.pathname === '/v1/credit-reports' && method === 'GET') {
    return sendJson(response, 200, service.getCreditOverview());
  }
  const creditReportDelete = url.pathname.match(/^\/v1\/credit-reports\/([0-9a-f-]{36})$/i);
  if (creditReportDelete && method === 'DELETE') {
    const id = creditReportDelete[1];
    if (!id) throw new AppError('invalid_input', 'Credit report id is required');
    return sendJson(response, 200, service.removeCreditReport(id));
  }
  if (url.pathname === '/v1/credit-reports/dispute-letter' && method === 'POST') {
    const input = parseSchema(disputeLetterSchema, await readJson(request));
    return sendJson(response, 200, service.generateCreditDisputeLetter(input));
  }
  if (url.pathname === '/v1/transactions' && method === 'GET') {
    const query = compact({
      accountId: url.searchParams.get('accountId'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
    });
    return sendJson(response, 200, service.listTransactions(query));
  }
  if (url.pathname === '/v1/summary' && method === 'GET') {
    const query = compact({
      accountId: url.searchParams.get('accountId'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
    return sendJson(response, 200, { items: service.summarize(query) });
  }
  if (url.pathname === '/v1/provider-connections' && method === 'GET') {
    return sendJson(response, 200, { items: service.listProviderConnections() });
  }
  if (url.pathname === '/v1/brokerage/summary' && method === 'GET') {
    return sendJson(response, 200, { items: service.summarizeBrokerage() });
  }
  if (url.pathname === '/v1/brokerage/transactions' && method === 'GET') {
    const query = compact({
      accountId: url.searchParams.get('accountId'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
    });
    return sendJson(response, 200, service.listBrokerageTransactions(query));
  }
  if (url.pathname === '/v1/brokerage/holdings' && method === 'GET') {
    return sendJson(response, 200, { items: service.listBrokerageHoldings(url.searchParams.get('accountId') ?? undefined) });
  }
  if (url.pathname === '/v1/account-balances' && method === 'GET') {
    return sendJson(response, 200, { items: service.listAccountBalances(url.searchParams.get('accountId') ?? undefined) });
  }
  if (url.pathname === '/v1/dashboards' && method === 'GET') {
    return sendJson(response, 200, { items: service.listDashboards() });
  }
  if (url.pathname === '/v1/settings' && method === 'GET') {
    const keys = url.searchParams.getAll('key').filter(Boolean);
    return sendJson(response, 200, { items: service.listAppSettings(keys.length ? keys : undefined) });
  }
  if (url.pathname === '/v1/settings' && method === 'POST') {
    const input = parseSchema(settingsSchema, await readJson(request));
    return sendJson(response, 200, service.saveAppSettings(input));
  }
  if (url.pathname === '/v1/telegram/connect' && method === 'POST') {
    return sendJson(response, 200, await service.connectTelegramChat());
  }
  if (url.pathname === '/v1/plaid/link-token' && method === 'POST') {
    return sendJson(response, 200, await service.createPlaidLinkToken());
  }
  if (url.pathname === '/v1/plaid/exchange' && method === 'POST') {
    const input = parseSchema(plaidExchangeSchema, await readJson(request));
    return sendJson(response, 200, await service.exchangePlaidPublicToken(input.public_token));
  }
  if (url.pathname === '/v1/plaid/update-link-token' && method === 'POST') {
    const input = parseSchema(plaidUpdateSchema, await readJson(request));
    return sendJson(response, 200, await service.createPlaidUpdateLinkToken(input.item_id, { accountSelection: input.accounts }));
  }
  if (url.pathname === '/v1/plaid/update-complete' && method === 'POST') {
    const input = parseSchema(plaidUpdateSchema, await readJson(request));
    return sendJson(response, 200, await service.completePlaidUpdate(input.item_id));
  }
  if (url.pathname === '/v1/snaptrade/connect' && method === 'POST') {
    return sendJson(response, 200, await service.createSnapTradePortal());
  }
  if (url.pathname === '/v1/snaptrade/remove' && method === 'POST') {
    const input = parseSchema(snaptradeRemoveSchema, await readJson(request));
    return sendJson(response, 200, await service.removeSnapTradeConnection(input.authorization_id));
  }
  if (url.pathname === '/v1/chat' && method === 'POST') {
    const input = parseSchema(chatSchema, await readJson(request, 256 * 1024));
    return sendJson(response, 200, await service.chat(input.messages, input.section, input.contextAttachments));
  }
  if (url.pathname === '/v1/llm' && method === 'GET') {
    return sendJson(response, 200, await service.getLlmStatus());
  }
  if (url.pathname === '/v1/llm/test' && method === 'POST') {
    return sendJson(response, 200, await service.testLocalModel());
  }
  if (url.pathname === '/v1/llm/model' && method === 'GET') {
    return sendJson(response, 200, await service.getBuiltinModelStatus());
  }
  if (url.pathname === '/v1/llm/model/download' && method === 'POST') {
    return sendJson(response, 200, await service.downloadBuiltinModel());
  }
  if (url.pathname === '/v1/llm/model/download' && method === 'DELETE') {
    return sendJson(response, 200, await service.cancelBuiltinModelDownload());
  }
  if (url.pathname === '/v1/llm/model' && method === 'DELETE') {
    return sendJson(response, 200, await service.deleteBuiltinModel());
  }
  if (url.pathname === '/v1/insights' && method === 'GET') {
    return sendJson(response, 200, { items: service.listInsights() });
  }
  if (url.pathname === '/v1/rules' && method === 'GET') {
    return sendJson(response, 200, { items: service.listRules() });
  }
  if (url.pathname === '/v1/rules/preview' && method === 'POST') {
    const input = parseSchema(ruleCreateSchema, await readJson(request));
    return sendJson(response, 200, await service.previewRule(input));
  }
  if (url.pathname === '/v1/rules' && method === 'POST') {
    const input = parseSchema(ruleCreateSchema, await readJson(request));
    return sendJson(response, 201, service.createRule(input));
  }
  if (url.pathname === '/v1/rules/toggle' && method === 'POST') {
    const input = parseSchema(ruleToggleSchema, await readJson(request));
    return sendJson(response, 200, service.toggleRule(input.id, input.enabled));
  }
  if (url.pathname === '/v1/rules/remove' && method === 'POST') {
    const input = parseSchema(ruleRemoveSchema, await readJson(request));
    return sendJson(response, 200, service.removeRule(input.id));
  }
  if (url.pathname === '/v1/insight-mutes' && method === 'GET') {
    return sendJson(response, 200, { items: service.listInsightMutes() });
  }
  if (url.pathname === '/v1/insight-mutes' && method === 'POST') {
    const input = parseSchema(insightMuteCreateSchema, await readJson(request));
    return sendJson(response, 201, service.createInsightMute(input));
  }
  if (url.pathname === '/v1/insight-mutes/remove' && method === 'POST') {
    const input = parseSchema(ruleRemoveSchema, await readJson(request));
    return sendJson(response, 200, service.removeInsightMute(input.id));
  }
  throw new HttpError(404, 'route_not_found', 'Route not found');
}

class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

function parseSchema<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('invalid_input', 'Request validation failed', {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data as z.output<S>;
}

async function readJson(request: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

async function sendAsset(response: ServerResponse, pathname: string, headOnly = false) {
  const distRoot = resolve(process.cwd(), 'dist', 'http', 'web');
  const bundledRoot = fileURLToPath(new URL('./web/', import.meta.url));
  const root = process.env.FINORA_WEB_ROOT || distRoot;
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (relative.startsWith('..')) throw new HttpError(404, 'asset_not_found', 'Asset not found');
  const fallback = extname(relative) ? relative : 'index.html';
  const candidates = [
    join(root, relative),
    join(bundledRoot, relative),
    join(root, fallback),
    join(bundledRoot, fallback),
  ];
  let body: Buffer | undefined;
  for (const candidate of candidates) {
    try {
      body = await readFile(candidate);
      break;
    } catch {
      // Try the next asset root.
    }
  }
  if (!body) throw new HttpError(404, 'asset_not_found', 'Asset not found');
  const contentType = contentTypeFor(fallback);
  response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
  if (headOnly) return response.end();
  response.end(body);
}

function contentTypeFor(pathname: string) {
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[extname(pathname)] || 'application/octet-stream';
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, error: unknown, requestId: string) {
  if (response.headersSent) return response.end();
  if (error instanceof HttpError) {
    return sendJson(response, error.status, { error: { code: error.code, message: error.message, details: {}, requestId } });
  }
  if (error instanceof AppError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'conflict' ? 409
        : error.code === 'unsupported_format' ? 415
          : error.code === 'not_implemented' ? 501
            : error.code === 'external_service' ? 502
            : 422;
    return sendJson(response, status, {
      error: { code: error.code, message: error.message, details: error.details, requestId },
    });
  }
  console.error({ requestId, error });
  return sendJson(response, 500, {
    error: { code: 'internal_error', message: 'An unexpected error occurred', details: {}, requestId },
  });
}

function setSecurityHeaders(response: ServerResponse, requestId: string) {
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self' https://cdn.plaid.com; connect-src 'self' https://*.plaid.com https://*.snaptrade.com; frame-src https://*.plaid.com https://plaid.com; child-src https://*.plaid.com https://plaid.com; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
}

function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], null | undefined> } {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== null && entry[1] !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], null | undefined>;
  };
}
