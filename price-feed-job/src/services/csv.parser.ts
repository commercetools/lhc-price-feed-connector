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
  const rows: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;

  const endCell = () => {
    cells.push(cell);
    cell = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endCell();
    // A blank line is one empty cell — skip it rather than report it.
    if (!(cells.length === 1 && cells[0] === '')) rows.push({ line: recordLine, cells });
    cells = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted && cell !== '') throw new CsvSyntaxError(line, 'a quote inside an unquoted field');
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\r' && input[i + 1] === '\n') {
      // CRLF: let the \n end the record
    } else if (ch === '\n') {
      endRecord();
      line++;
      recordLine = line;
    } else {
      cell += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new CsvSyntaxError(recordLine, 'an unterminated quoted field');
  if (cell !== '' || cells.length > 0) endRecord();

  const [head, ...records] = rows;
  if (!head) return { header: [], records: [] };
  return { header: head.cells.map((h) => h.trim()), records };
}
