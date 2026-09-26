# Changelog

## Unreleased

### Fixed

- On a terminal, an error no longer runs into the "checked N of M requests" progress line, and no progress line is
  printed after an error.
- A TypeSafe answer that is not JSON stops the run with "TypeSafe answered without answers." instead of an
  unexpected error. So does an answer whose `answers` is `null`; it used to put every chunk in review.
- A fix answer the question did not offer, such as merge with previous for the first chunk of a document, puts the
  chunk in review instead of being reported as a fix. An unknown name was printed as "fix: undefined".
- A line such as ```` ```inline``` code ```` no longer opens a code block that hides the headings after it: under
  CommonMark, a backtick fence cannot have a backtick after it on its line.
- JSONL input: a chunk without an id is named by its position (`#1 line 5`, not `line 5 line 5`), and the report and
  the dry run say "source" where they said "file".
- A folder whose name ends in `.jsonl` is reported as a folder of files, not as JSONL input, and no longer gets the
  note that `--by` is ignored.

### Changed

- The message for an unsupported input names both JSONL extensions, `.jsonl` and `.ndjson`.
- The README says what is retried (timeouts and network errors as well as 429 and 529), and the README and `--help`
  give the 600-second limit of `--timeout`. The README also lists the `.ndjson` extension, the `chunk_id` field,
  what a folder scan skips (dot files and symbolic links) and that empty chunks are skipped.
- CI runs the tests on Node.js 20, 22 and 24.

## 1.0.0

First release.
