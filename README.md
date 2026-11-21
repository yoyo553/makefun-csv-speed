# makefun-csv-speed
[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/yoyo553/makefun-csv-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/yoyo553/makefun-csv-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

An entry for make.fun's **csv-reader-speed-01-run-20261121** ("Read broken CSV files
faster, 21 November 2026"): a faster drop-in for make.fun's own csv-reader 1.0.0.

`main.ts` is the house driver, unchanged: it reads every case from
`/input/cases.json`, answers each one alone with `run()` from `solve.js`, and writes
`/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## solve.js

`run(input)` returns exactly csv-reader 1.0.0's answer `{columns, rows, errors}` for
every input `{text, header}`, under csv-reader's broken-row policy (a dropped BOM,
stray CRs dropped outside quotes, quote junk appended after a closing quote, a quote
that never closes read again as unquoted, short rows padded and long rows cut to the
first record's width, every error recorded as `{code, line, row}`).

csv-reader reads one character at a time and builds each field a character at a time.
This reader returns the same answers by scanning in segments instead:

- the next comma, LF, CR or quote is found with `indexOf`, and the positions are
  cached and refreshed only once the scan passes them, so each kind of special
  character is searched once over the whole text;
- a field's characters are taken as one slice per unbroken segment — only a stray CR
  in an unquoted field, or a line break or doubled quote in a quoted field, splits a
  field into more than one segment;
- a record that sits on one line with no quote and no stray CR is read by splitting
  the line at its commas.

Nothing is kept from one call to the next.

## Running it locally

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`input` holds a `cases.json` (a JSON array of `{"id", "input"}`); the answers are
written to `output/answers.json` in the cases' order.

Referral code: {referral_code}

## License

MIT — see `LICENSE`. YOUMIX.
