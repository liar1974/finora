import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { FinanceService } from '../application/finance-service.js';
import { createApplication } from '../composition.js';

export function createMcpServer(service: FinanceService): McpServer {
  const server = new McpServer({ name: 'finora', version: '0.1.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const writeHint = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool('list_accounts', {
    title: 'List accounts',
    description: 'List all local financial accounts with their IDs, institutions, types, and currencies.',
    annotations: readOnly,
  }, async () => text(service.listAccounts()));

  server.registerTool('list_transactions', {
    title: 'List transactions',
    description: 'Read transactions in reverse chronological order. Amounts are integer minor units: positive is inflow and negative is outflow.',
    inputSchema: {
      accountId: z.string().uuid().optional().describe('Filter by account ID'),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive start date'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive end date'),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().optional().describe('Opaque cursor returned by the previous call'),
    },
    annotations: readOnly,
  }, async (input) => text(service.listTransactions(compact(input))));

  server.registerTool('get_cash_flow_summary', {
    title: 'Get cash flow summary',
    description: 'Calculate income, expenses, and net cash flow, grouped by currency.',
    inputSchema: {
      accountId: z.string().uuid().optional().describe('Filter by account ID'),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive start date'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive end date'),
    },
    annotations: readOnly,
  }, async (input) => text(service.summarize(compact(input))));

  server.registerTool('recall', {
    title: 'Recall user memory',
    description:
      'Return the durable user memory profile as markdown. It has four fixed sections: Identity, Preferences, Goals & Background, Behavior Patterns. Never use it as a source of financial numbers.',
    annotations: readOnly,
  }, async () => text(service.recallMemory()));

  server.registerTool('remember', {
    title: 'Remember a durable fact',
    description:
      'Store a slow-changing fact about the user when they explicitly state one (identity, a preference or reporting convention, a goal/background, or a behavior pattern). Never store financial numbers, balances, amounts, or anything that could change with the next transaction — that is data, not memory.',
    inputSchema: {
      value: z.string().min(1).max(500).describe('The durable fact to remember'),
      section: z
        .enum(['Identity', 'Preferences', 'Goals & Background', 'Behavior Patterns'])
        .optional()
        .describe('Target section; inferred from kind when omitted'),
      kind: z.string().max(40).optional().describe('identity | preference | goal | context | behavior'),
    },
    annotations: writeHint,
  }, async (input) => text(service.remember({
    value: input.value,
    ...(input.section ? { section: input.section } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
  })));

  server.registerTool('forget', {
    title: 'Forget (unsupported)',
    description:
      'Targeted forget is not supported: memory is one rewritten document. Correct a fact with remember instead.',
    annotations: writeHint,
  }, async () => text(service.forgetMemory()));

  server.registerResource('data-model', 'finora://data-model', {
    title: 'Finora data model',
    description: 'Money direction and query semantics for Finora tools.',
    mimeType: 'text/markdown',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/markdown',
      text: [
        '# Finora data model',
        '',
        'Amounts are signed integer minor units. Positive values are inflows and negative values are outflows.',
        'Every amount includes a currency. Never aggregate different currencies into one total.',
        'Transactions are read-only through MCP. Use the local UI, HTTP API, or CLI for imports.',
      ].join('\n'),
    }],
  }));

  return server;
}

export async function runMcpServer(service = createApplication()): Promise<void> {
  const server = createMcpServer(service);
  const shutdown = async () => {
    await server.close();
    service.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await server.connect(new StdioServerTransport());
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runMcpServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
