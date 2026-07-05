import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { FinanceService } from '../src/application/finance-service.js';
import { LocalModelEngine } from '../src/infrastructure/local-model.js';
import { CsvStatementParser } from '../src/infrastructure/parsers/csv-parser.js';
import { OfxStatementParser } from '../src/infrastructure/parsers/ofx-parser.js';
import { SqliteFinanceRepository } from '../src/infrastructure/sqlite-repository.js';
import { createMcpServer } from '../src/mcp/server.js';

describe('MCP server', () => {
  it('exposes the shared application service as read-only tools', async () => {
    const service = new FinanceService(
      new SqliteFinanceRepository(':memory:'),
      [new OfxStatementParser(), new CsvStatementParser()],
      new LocalModelEngine(join(tmpdir(), 'finora-test-models-missing')),
    );
    service.createAccount({ institution: 'Example Bank', name: 'Checking', type: 'checking', currency: 'USD' });
    const server = createMcpServer(service);
    const client = new Client({ name: 'finora-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'list_accounts', 'list_transactions', 'get_cash_flow_summary',
    ]);
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(JSON.stringify(result.content)).toContain('Example Bank');
    const resources = await client.listResources();
    expect(resources.resources[0]?.uri).toBe('finora://data-model');

    await client.close();
    await server.close();
    service.close();
  });
});
