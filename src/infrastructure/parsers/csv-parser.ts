import { parse } from 'csv-parse/sync';
import type { ParseContext, StatementParser } from '../../application/ports.js';
import type { TransactionInput } from '../../domain/models.js';

type Row = Record<string, string>;

interface Columns {
  date: string;
  description: string;
  amount?: string;
  debit?: string;
  credit?: string;
  direction?: string;
  category?: string;
  id?: string;
}

export class CsvStatementParser implements StatementParser {
  readonly format = 'csv';

  supports(filename: string, content: Uint8Array): boolean {
    if (/\.csv$/i.test(filename)) return true;
    const sample = new TextDecoder().decode(content.slice(0, 512));
    return sample.includes(',') && sample.includes('\n');
  }

  parse(content: Uint8Array, context: ParseContext): TransactionInput[] {
    const rows = parse(new TextDecoder().decode(content), {
      bom: true,
      columns: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as Row[];
    if (rows.length === 0) return [];
    const columns = inferColumns(Object.keys(rows[0] ?? {}));

    return rows.map((row, index) => {
      const date = parseDate(row[columns.date] ?? '');
      const description = (row[columns.description] ?? '').trim();
      const amountMinor = parseRowAmount(row, columns);
      if (!date) throw new Error(`Row ${index + 2}: invalid date`);
      if (!description) throw new Error(`Row ${index + 2}: description is empty`);
      if (amountMinor === null) throw new Error(`Row ${index + 2}: amount is invalid`);
      return {
        sourceId: columns.id ? nonEmpty(row[columns.id]) : null,
        date,
        description,
        amountMinor,
        category: columns.category ? nonEmpty(row[columns.category]) : null,
        pending: false,
        metadata: { format: 'csv', row: index + 2, filename: context.filename },
      };
    });
  }
}

function inferColumns(headers: string[]): Columns {
  const normalized = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const pick = (...names: string[]) => names.map((name) => normalized.get(name)).find(Boolean);
  const date = pick('date', 'posted date', 'posting date', 'transaction date');
  const description = pick(
    'description',
    'details',
    'memo',
    'merchant',
    'name',
    'payee',
    'transaction',
  );
  const amount = pick('amount', 'transaction amount', 'value');
  const debit = pick('debit', 'debits', 'withdrawal', 'withdrawals', 'charge');
  const credit = pick('credit', 'credits', 'deposit', 'deposits');
  if (!date) throw new Error('CSV requires a date column');
  if (!description) throw new Error('CSV requires a description column');
  if (!amount && !debit && !credit) {
    throw new Error('CSV requires an amount column or debit/credit columns');
  }
  return {
    date,
    description,
    ...(amount ? { amount } : {}),
    ...(debit ? { debit } : {}),
    ...(credit ? { credit } : {}),
    ...(pick('type', 'direction', 'debit credit', 'dr cr')
      ? { direction: pick('type', 'direction', 'debit credit', 'dr cr')! }
      : {}),
    ...(pick('category', 'classification') ? { category: pick('category', 'classification')! } : {}),
    ...(pick('id', 'transaction id', 'reference', 'reference id', 'fitid')
      ? { id: pick('id', 'transaction id', 'reference', 'reference id', 'fitid')! }
      : {}),
  };
}

function parseRowAmount(row: Row, columns: Columns): number | null {
  if (columns.debit || columns.credit) {
    const debit = columns.debit ? parseMoney(row[columns.debit] ?? '') : null;
    const credit = columns.credit ? parseMoney(row[columns.credit] ?? '') : null;
    if (debit === null && credit === null) return null;
    return Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
  }
  const value = columns.amount ? parseMoney(row[columns.amount] ?? '') : null;
  if (value === null) return null;
  const direction = columns.direction ? (row[columns.direction] ?? '').trim().toLowerCase() : '';
  if (/^(debit|debit card|withdrawal|charge|purchase|fee|dr|d)$/.test(direction)) {
    return -Math.abs(value);
  }
  if (/^(credit|deposit|refund|payment|interest|dividend|cr|c)$/.test(direction)) {
    return Math.abs(value);
  }
  return value;
}

export function parseMoney(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || text.endsWith('-');
  const cleaned = text.replace(/[,$€£¥\s()]/g, '').replace(/-$/, '');
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const sign = cleaned.startsWith('-') || negative ? -1 : 1;
  const unsigned = cleaned.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? sign * value : null;
}

function parseDate(raw: string): string | null {
  const value = raw.trim();
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(value);
  if (match) return validDate(match[1]!, match[2]!, match[3]!);
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})/.exec(value);
  if (!match) return null;
  const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;
  return validDate(year, match[1]!, match[2]!);
}

function validDate(year: string, month: string, day: string): string | null {
  const result = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === result ? result : null;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function nonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}
