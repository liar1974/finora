#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApplication } from './composition.js';
import { loadConfig } from './config.js';
import { startHttpServer } from './http/server.js';

const usage = `Finora CLI

Usage:
  finora accounts list
  finora accounts add --institution <name> --name <name> [--type checking] [--currency USD]
  finora ingest <file> --account <account-id> [--format auto|csv|ofx]
  finora transactions [--account <account-id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit 50]
  finora summary [--account <account-id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  finora memory
  finora reflect
  finora serve
  finora mcp
`;

async function main() {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(usage);
    return;
  }
  if (command === 'mcp') {
    const { runMcpServer } = await import('./mcp/server.js');
    await runMcpServer();
    return;
  }

  const config = loadConfig();
  const service = createApplication(config);
  const close = () => service.close();

  if (command === 'serve') {
    const server = startHttpServer(service, config);
    const shutdown = () => server.close(close);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  try {
    if (command === 'accounts' && subcommand === 'list') {
      print(service.listAccounts());
      return;
    }
    if (command === 'accounts' && subcommand === 'add') {
      const flags = parseFlags(rest);
      print(service.createAccount({
        institution: required(flags, 'institution'),
        name: required(flags, 'name'),
        type: flags.type ?? 'checking',
        currency: flags.currency ?? 'USD',
      }));
      return;
    }
    if (command === 'ingest') {
      const filename = subcommand;
      if (!filename) throw new Error('ingest requires a file path');
      const flags = parseFlags(rest);
      const result = service.importStatement({
        accountId: required(flags, 'account'),
        filename,
        format: flags.format ?? 'auto',
        content: await readFile(resolve(filename)),
      });
      await service.notifyTelegramAlerts();
      print(result);
      return;
    }
    if (command === 'transactions') {
      const flags = parseFlags([subcommand, ...rest].filter((value): value is string => Boolean(value)));
      print(service.listTransactions(compact({
        accountId: flags.account,
        from: flags.from,
        to: flags.to,
        limit: flags.limit ? Number(flags.limit) : 50,
        cursor: flags.cursor,
      })));
      return;
    }
    if (command === 'summary') {
      const flags = parseFlags([subcommand, ...rest].filter((value): value is string => Boolean(value)));
      print(service.summarize(compact({ accountId: flags.account, from: flags.from, to: flags.to })));
      return;
    }
    if (command === 'memory') {
      print(service.recallMemory());
      return;
    }
    if (command === 'reflect') {
      print(await service.runReflection());
      return;
    }
    throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`);
  } finally {
    close();
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    flags[token.slice(2)] = value;
    index += 1;
  }
  return flags;
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
