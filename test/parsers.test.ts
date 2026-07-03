import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CsvStatementParser, parseMoney } from '../src/infrastructure/parsers/csv-parser.js';
import { OfxStatementParser } from '../src/infrastructure/parsers/ofx-parser.js';

describe('statement parsers', () => {
  it('parses money without floating point arithmetic', () => {
    expect(parseMoney('$1,234.56')).toBe(123456);
    expect(parseMoney('(42.10)')).toBe(-4210);
    expect(parseMoney('10.1')).toBe(1010);
    expect(parseMoney('not money')).toBeNull();
  });

  it('normalizes debit and credit columns', async () => {
    const content = await readFile(new URL('./fixtures/checking.csv', import.meta.url));
    const transactions = new CsvStatementParser().parse(content, {
      currency: 'USD',
      filename: 'checking.csv',
    });
    expect(transactions).toHaveLength(3);
    expect(transactions.map((item) => item.amountMinor)).toEqual([-4217, 250000, -8430]);
    expect(transactions[0]).toMatchObject({
      sourceId: 'txn-1',
      date: '2026-06-01',
      description: 'Neighborhood Market',
      category: 'Groceries',
    });
  });

  it('preserves standard OFX signs', async () => {
    const content = await readFile(new URL('./fixtures/checking.ofx', import.meta.url));
    const transactions = new OfxStatementParser().parse(content, {
      currency: 'USD',
      filename: 'checking.ofx',
    });
    expect(transactions).toHaveLength(2);
    expect(transactions.map((item) => item.amountMinor)).toEqual([-1250, 10000]);
    expect(transactions[0]).toMatchObject({ sourceId: 'ofx-1', description: 'Coffee Shop' });
  });
});
