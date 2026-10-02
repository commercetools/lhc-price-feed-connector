import { describe, expect, it } from 'vitest';
import { decimalToCents, rowsFromCsv } from '../src/services/feed.service.js';
import { parseCsv } from '../src/services/csv.parser.js';
import { isUnchanged } from '../src/services/run-state.service.js';

describe('reading a CSV the way ERPs actually write them', () => {
  it('handles a BOM, CRLF, quoted fields, escaped quotes and blank lines', () => {
    const doc = parseCsv('﻿sku,note\r\n"A-1","has, comma"\r\n\r\nB-2,"say ""hi"""\r\n');
    expect(doc.header).toEqual(['sku', 'note']);
    expect(doc.records).toEqual([
      { line: 2, cells: ['A-1', 'has, comma'] },
      { line: 4, cells: ['B-2', 'say "hi"'] },
    ]);
  });

  it('keeps the line a multi-line quoted record started on', () => {
    const doc = parseCsv('sku,note\n"A-1","two\nlines"\nB-2,x\n');
    expect(doc.records.map((r) => r.line)).toEqual([2, 4]);
  });

  it('refuses an unterminated quote instead of guessing', () => {
    expect(() => parseCsv('sku\n"A-1\n')).toThrow(/unterminated/);
  });
});

describe('money: decimal amounts become exact centAmounts', () => {
  it('uses the currency’s own fraction digits, with no floating point', () => {
    expect(decimalToCents('449.00', 'EUR')).toBe(44900);
    expect(decimalToCents('25.99', 'USD')).toBe(2599);
    expect(decimalToCents('19.9', 'GBP')).toBe(1990);
    expect(decimalToCents('0.29', 'EUR')).toBe(29); // 0.29 * 100 is 28.999… in floating point
    expect(decimalToCents('1500', 'JPY')).toBe(1500); // zero fraction digits
  });

  it('rejects what an import must not guess at', () => {
    expect(decimalToCents('1,299.00', 'EUR')).toBeNull(); // thousands separator
    expect(decimalToCents('-5.00', 'EUR')).toBeNull();
    expect(decimalToCents('9.999', 'EUR')).toBeNull(); // more digits than the currency has
    expect(decimalToCents('12.5', 'JPY')).toBeNull();
  });
});

describe('feed rows', () => {
  it('maps columns by header name, case-insensitively and in any order', () => {
    const { rows, rejected } = rowsFromCsv('Amount,Country,SKU,Currency\n449.00,de,CARM-023,eur\n');
    expect(rejected).toEqual([]);
    expect(rows).toEqual([{ sku: 'CARM-023', currencyCode: 'EUR', centAmount: 44900, country: 'DE' }]);
  });

  it('accepts integer centAmount instead of a decimal amount', () => {
    expect(rowsFromCsv('sku,currencyCode,centAmount\nLPC-011,USD,2599\n').rows)
      .toEqual([{ sku: 'LPC-011', currencyCode: 'USD', centAmount: 2599 }]);
  });

  it('reports bad rows by line number instead of dropping them silently', () => {
    const { rows, rejected } = rowsFromCsv('sku,currency,country,amount\nCARM-023,EUR,DE,449.00\n,EUR,DE,1\nX,EURO,,1\nY,EUR,DEU,1\nZ,EUR,,abc\n');
    expect(rows).toHaveLength(1);
    expect(rejected.map((r) => [r.line, r.reason.split(' ')[0]])).toEqual([[3, 'sku'], [4, 'currency'], [5, 'country'], [6, 'amount']]);
  });

  it('lets the later line win when one price appears twice', () => {
    const { rows } = rowsFromCsv('sku,currency,country,amount\nA,EUR,DE,1.00\nA,EUR,DE,2.00\n');
    expect(rows).toEqual([{ sku: 'A', currencyCode: 'EUR', centAmount: 200, country: 'DE' }]);
  });

  it('fails the whole file when a required column is missing', () => {
    expect(() => rowsFromCsv('sku,amount\nA,1\n')).toThrow(/missing: currency/);
  });
});

describe('skipping an unchanged file', () => {
  const last = { fingerprint: 'abc', source: 's', finishedAt: 'x', imported: 6, failed: 0 };
  it('skips only an identical file whose last import fully succeeded', () => {
    expect(isUnchanged(last, 'abc')).toBe(true);
    expect(isUnchanged(last, 'def')).toBe(false);
    expect(isUnchanged({ ...last, failed: 1 }, 'abc')).toBe(false); // retry a file that partly failed
    expect(isUnchanged(undefined, 'abc')).toBe(false);
  });
});
