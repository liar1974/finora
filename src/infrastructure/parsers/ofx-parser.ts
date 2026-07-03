import type { ParseContext, StatementParser } from '../../application/ports.js';
import type { TransactionInput } from '../../domain/models.js';
import { parseMoney } from './csv-parser.js';

export class OfxStatementParser implements StatementParser {
  readonly format = 'ofx';

  supports(filename: string, content: Uint8Array): boolean {
    if (/\.(ofx|qfx)$/i.test(filename)) return true;
    return /<OFX>/i.test(new TextDecoder().decode(content.slice(0, 1024)));
  }

  parse(content: Uint8Array, context: ParseContext): TransactionInput[] {
    const document = new TextDecoder().decode(content);
    const currency = tag(document, 'CURDEF') ?? context.currency;
    const blocks = [...document.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>|<\/BANKTRANLIST>))/gi)];
    return blocks.map((match, index) => {
      const block = match[1] ?? '';
      const rawDate = tag(block, 'DTPOSTED') ?? tag(block, 'DTUSER');
      const amount = parseMoney(tag(block, 'TRNAMT') ?? '');
      const description = tag(block, 'NAME') ?? tag(block, 'MEMO');
      if (!rawDate || !/^\d{8}/.test(rawDate)) throw new Error(`Transaction ${index + 1}: invalid date`);
      if (amount === null) throw new Error(`Transaction ${index + 1}: invalid amount`);
      if (!description?.trim()) throw new Error(`Transaction ${index + 1}: description is empty`);
      return {
        sourceId: tag(block, 'FITID'),
        date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
        description: description.trim(),
        amountMinor: amount,
        category: null,
        pending: (tag(block, 'TRNTYPE') ?? '').toUpperCase() === 'HOLD',
        metadata: {
          format: 'ofx',
          transactionType: tag(block, 'TRNTYPE'),
          currency,
          filename: context.filename,
        },
      };
    });
  }
}

function tag(document: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<\\r\\n]+)`, 'i').exec(document);
  return match?.[1]?.trim() || null;
}
