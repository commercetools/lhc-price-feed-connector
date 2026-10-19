/**
 * A small RFC 4180 CSV reader — enough for an ERP price export, with no dependency to audit.
 *
 * Handles what real exports contain: a UTF-8 BOM, CRLF or LF line endings, quoted fields containing
 * commas, quotes (`""`) and line breaks, and blank lines. Every record keeps the line it STARTED on, so
 * a rejected row can be reported as "line 14", which is what the person fixing the file needs.
 */
export interface CsvRecord {
  /** 1-based line number in the file where this record starts. */
  line: number;
  cells: string[];
}

export interface CsvDocument {
  header: string[];
  records: CsvRecord[];
}

export class CsvSyntaxError extends Error {
  constructor(
    readonly line: number,
    message: string
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'CsvSyntaxError';
  }
}

export function parseCsv(text: string, delimiter = ','): CsvDocument {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const scanner = new CsvScanner(delimiter);
  let skipNext = false;
  for (let i = 0; i < input.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    skipNext = scanner.consume(input[i]!, input[i + 1]);
  }
  const [head, ...records] = scanner.finish();
  if (!head) return { header: [], records: [] };
  return { header: head.cells.map((h) => h.trim()), records };
}

/** The RFC 4180 state machine, one character at a time. */
class CsvScanner {
  private readonly rows: CsvRecord[] = [];
  private cells: string[] = [];
  private cell = '';
  private quoted = false;
  private fieldStarted = false;
  private line = 1;
  private recordLine = 1;

  constructor(private readonly delimiter: string) {}

  /** Consumes `ch`; returns true when `next` was consumed as well (an escaped quote). */
  consume(ch: string, next: string | undefined): boolean {
    return this.quoted ? this.consumeQuoted(ch, next) : this.consumePlain(ch, next);
  }

  finish(): CsvRecord[] {
    if (this.quoted) throw new CsvSyntaxError(this.recordLine, 'an unterminated quoted field');
    if (this.cell !== '' || this.cells.length > 0) this.endRecord();
    return this.rows;
  }

  private consumeQuoted(ch: string, next: string | undefined): boolean {
    if (ch !== '"') {
      if (ch === '\n') this.line++;
      this.cell += ch;
      return false;
    }
    if (next === '"') {
      this.cell += '"';
      return true;
    }
    this.quoted = false;
    return false;
  }

  private consumePlain(ch: string, next: string | undefined): boolean {
    if (ch === '"') this.openQuote();
    else if (ch === this.delimiter) this.endCell();
    else if (ch === '\n') this.endLine();
    else if (!(ch === '\r' && next === '\n')) this.append(ch); // CRLF: let the \n end the record
    return false;
  }

  private openQuote(): void {
    if (this.fieldStarted && this.cell !== '') throw new CsvSyntaxError(this.line, 'a quote inside an unquoted field');
    this.quoted = true;
    this.fieldStarted = true;
  }

  private append(ch: string): void {
    this.cell += ch;
    this.fieldStarted = true;
  }

  private endLine(): void {
    this.endRecord();
    this.line++;
    this.recordLine = this.line;
  }

  private endCell(): void {
    this.cells.push(this.cell);
    this.cell = '';
    this.fieldStarted = false;
  }

  private endRecord(): void {
    this.endCell();
    // A blank line is one empty cell — skip it rather than report it.
    if (!(this.cells.length === 1 && this.cells[0] === '')) this.rows.push({ line: this.recordLine, cells: this.cells });
    this.cells = [];
  }
}
