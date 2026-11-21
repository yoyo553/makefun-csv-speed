// A faster drop-in for csv-reader 1.0.0, make.fun's own reference CSV reader, for
// csv-reader-speed-01: run(input) returns exactly csv-reader's answer {columns, rows, errors}
// for every input {text, header}, under the same broken-row policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it
//     one quote, and each CRLF or lone CR inside it read as LF; what follows its closing quote,
//     up to the next comma or line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character and the text after it is read
//     again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after
//     it (every record when header is false), each padded with "" (short_row, with fields: its
//     count) or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF,
//     CRLF and lone CR inside a quoted field counted), row its record's index in rows (null
//     for the header), in the order met, a field's quote_junk when the field ends and a
//     record's short_row or long_row when the record ends.
//
// csv-reader reads one character at a time and builds each field a character at a time. This
// reader returns the same answers by scanning in segments: the next comma, line feed, carriage
// return or quote is found with indexOf (positions are cached and only refreshed once the scan
// passes them, so each kind of special is searched once over the whole text), and a field's
// characters are taken as one slice per unbroken segment. Only a stray CR inside an unquoted
// field, or a line break or doubled quote inside a quoted field, splits a field into more than
// one segment. Nothing is kept from one call to the next: every call builds its own state.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: at a comma (the record goes on), at a line break or at the end. */
const COMMA = 0;
const BREAK = 1;
const END = 2;
/** A carriage return met while scanning an unquoted field (a line break or a stray CR). */
const CR = 3;

/**
 * Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed
 * by LF is dropped (stray_cr). Sets R.v to the field, R.e to how it ended and R.a to the
 * number of characters kept (the caller of a junk read needs it for quote_junk). S holds the
 * scan state {pos, line, nComma, nLF, nCR, nQuote}: the position, the line it is on, and the
 * cached next index of each special character (-1: none left in the text).
 */
function scanUnquoted(text, len, S, errors, recordLine, recordRow, init, R) {
  let parts = null; // the field's segments before segStart, once a stray CR splits it
  let segStart = S.pos;
  let added = 0;
  for (;;) {
    if (S.nComma !== -1 && S.nComma < S.pos) S.nComma = text.indexOf(',', S.pos);
    if (S.nLF !== -1 && S.nLF < S.pos) S.nLF = text.indexOf('\n', S.pos);
    if (S.nCR !== -1 && S.nCR < S.pos) S.nCR = text.indexOf('\r', S.pos);
    let m = -1;
    let kind = END;
    if (S.nComma !== -1) { m = S.nComma; kind = COMMA; }
    if (S.nLF !== -1 && (m === -1 || S.nLF < m)) { m = S.nLF; kind = BREAK; }
    if (S.nCR !== -1 && (m === -1 || S.nCR < m)) { m = S.nCR; kind = CR; }
    if (m === -1) {
      added += len - segStart;
      R.v = parts === null
        ? (init === '' ? text.slice(segStart, len) : init + text.slice(segStart, len))
        : init + parts.join('') + text.slice(segStart, len);
      R.e = END;
      R.a = added;
      S.pos = len;
      return;
    }
    if (kind === CR && text.charCodeAt(m + 1) !== 10) {
      // A stray CR: dropped, its error recorded, and the field goes on.
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, m));
      added += m - segStart;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      S.pos = m + 1;
      segStart = S.pos;
      continue;
    }
    // The field ends at m: at a comma, at an LF, or at the CR of a CRLF.
    added += m - segStart;
    R.v = parts === null
      ? (init === '' ? text.slice(segStart, m) : init + text.slice(segStart, m))
      : init + parts.join('') + text.slice(segStart, m);
    R.a = added;
    if (kind === COMMA) {
      R.e = COMMA;
      S.pos = m + 1;
    } else {
      R.e = BREAK;
      S.pos = kind === CR ? m + 2 : m + 1;
      S.line += 1;
    }
    return;
  }
}

/**
 * Reads a quoted field whose opening quote is at S.pos, into R (R.v the field, R.e how it
 * ended). A quote that never closes is a literal character: the unterminated_quote error is
 * recorded and the text after the opening quote is read again as unquoted. What follows a
 * closing quote, up to the next comma or line break, is appended as it stands, and quote_junk
 * is recorded when the field ends if anything was appended.
 */
function scanQuoted(text, len, S, errors, recordLine, recordRow, R) {
  const openPos = S.pos;
  const openLine = S.line;
  S.pos += 1; // the opening quote
  let parts = null; // the field's segments before segStart, once a special splits it
  let segStart = S.pos;
  let value;
  for (;;) {
    if (S.nQuote !== -1 && S.nQuote < S.pos) S.nQuote = text.indexOf('"', S.pos);
    if (S.nCR !== -1 && S.nCR < S.pos) S.nCR = text.indexOf('\r', S.pos);
    if (S.nLF !== -1 && S.nLF < S.pos) S.nLF = text.indexOf('\n', S.pos);
    let m = -1;
    let kind = -1; // 0: a quote, 1: a CR, 2: an LF
    if (S.nQuote !== -1) { m = S.nQuote; kind = 0; }
    if (S.nCR !== -1 && (m === -1 || S.nCR < m)) { m = S.nCR; kind = 1; }
    if (S.nLF !== -1 && (m === -1 || S.nLF < m)) { m = S.nLF; kind = 2; }
    if (m === -1) {
      // The quote never closes: it is a literal character, and the text after it is read
      // again as unquoted. The scan position moves backwards, so the cached indexes of the
      // special characters no longer hold and are dropped.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      S.pos = openPos + 1;
      S.line = openLine;
      S.nComma = -2;
      S.nLF = -2;
      S.nCR = -2;
      S.nQuote = -2;
      scanUnquoted(text, len, S, errors, recordLine, recordRow, '"', R);
      return;
    }
    if (kind === 0) {
      if (text.charCodeAt(m + 1) === 34) {
        // A doubled quote is one quote in the field.
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, m), '"');
        S.pos = m + 2;
        segStart = S.pos;
        continue;
      }
      // The closing quote.
      value = parts === null ? text.slice(segStart, m) : (parts.push(text.slice(segStart, m)), parts.join(''));
      S.pos = m + 1;
      break;
    }
    if (kind === 1) {
      // A CRLF or a lone CR inside quotes is read as one LF.
      if (parts === null) parts = [];
      parts.push(text.slice(segStart, m), '\n');
      S.line += 1;
      S.pos = text.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
      segStart = S.pos;
      continue;
    }
    // An LF inside quotes is kept as it stands and counts as a line.
    if (parts === null) parts = [];
    parts.push(text.slice(segStart, m + 1));
    S.line += 1;
    S.pos = m + 1;
    segStart = S.pos;
  }
  // What follows the closing quote.
  if (S.pos >= len) {
    R.v = value;
    R.e = END;
    R.a = 0;
    return;
  }
  const c = text.charCodeAt(S.pos);
  if (c === 44) {
    S.pos += 1;
    R.v = value;
    R.e = COMMA;
    R.a = 0;
    return;
  }
  if (c === 10) {
    S.pos += 1;
    S.line += 1;
    R.v = value;
    R.e = BREAK;
    R.a = 0;
    return;
  }
  if (c === 13 && text.charCodeAt(S.pos + 1) === 10) {
    S.pos += 2;
    S.line += 1;
    R.v = value;
    R.e = BREAK;
    R.a = 0;
    return;
  }
  // Junk after the closing quote, appended as it stands up to the next comma or line break.
  scanUnquoted(text, len, S, errors, recordLine, recordRow, value, R);
  if (R.a > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
}

/** csv-reader 1.0.0's answer for one case's input, read faster. */
export function run(input) {
  const rawText = input.text;
  const text = typeof rawText === 'string' ? rawText : String(rawText);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const S = { pos: 0, line: 1, nComma: -2, nLF: -2, nCR: -2, nQuote: -2 };
  if (text.charCodeAt(0) === 0xFEFF) S.pos = 1; // a BOM at the very start is dropped
  const R = { v: '', e: END, a: 0 };

  for (;;) {
    // Lines with no characters are no records.
    while (S.pos < len) {
      const c = text.charCodeAt(S.pos);
      if (c === 10) {
        S.pos += 1;
        S.line += 1;
      } else if (c === 13 && text.charCodeAt(S.pos + 1) === 10) {
        S.pos += 2;
        S.line += 1;
      } else {
        break;
      }
    }
    if (S.pos >= len) break;

    const recordLine = S.line;
    const recordRow = header && columns === null ? null : rows.length;
    let fields = null;
    let lastQuoted = false;

    // Fast path: the record is a single line holding no quote and no CR but the CR of a
    // closing CRLF, so its fields are the line split at its commas.
    if (S.nLF !== -1 && S.nLF < S.pos) S.nLF = text.indexOf('\n', S.pos);
    const lineEnd = S.nLF === -1 ? len : S.nLF;
    if (S.nQuote !== -1 && S.nQuote < S.pos) S.nQuote = text.indexOf('"', S.pos);
    if (S.nCR !== -1 && S.nCR < S.pos) S.nCR = text.indexOf('\r', S.pos);
    let effEnd = -1;
    if (S.nQuote === -1 || S.nQuote >= lineEnd) {
      if (S.nCR === -1 || S.nCR >= lineEnd) effEnd = lineEnd;
      else if (S.nCR === lineEnd - 1 && S.nLF !== -1) effEnd = lineEnd - 1;
    }
    if (effEnd !== -1) {
      fields = text.slice(S.pos, effEnd).split(',');
      if (S.nLF === -1) {
        S.pos = len;
      } else {
        S.pos = S.nLF + 1;
        S.line += 1;
      }
    } else {
      fields = [];
      for (;;) {
        if (text.charCodeAt(S.pos) === 34) {
          lastQuoted = true;
          scanQuoted(text, len, S, errors, recordLine, recordRow, R);
        } else {
          lastQuoted = false;
          scanUnquoted(text, len, S, errors, recordLine, recordRow, '', R);
        }
        fields.push(R.v);
        if (R.e !== COMMA) break;
      }
    }

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
