# chunk-standalone

Finds the chunks in a RAG knowledge base that a reader could not understand on their own, and suggests keep, merge
or split for each; for anyone who chunks Markdown or text documents for retrieval.

A retriever returns chunks one at a time. A chunk that opens with "As shown above", promises "the following
settings" that sit in the next chunk, or calls the product "it" reaches the answering model without the text it
depends on, and the answer built on it comes out vague or wrong. A regular expression can find "above" and "this", but it cannot
tell whether the chunk explains them itself. A text-generating model can judge that, but it returns prose to parse
and no measure of how sure it is. chunk-standalone asks narrow yes/no and multiple-choice questions and gets
probabilities back, so code makes the decision and unclear cases go to a review list.

## How it uses Jev

Jev is TypeSafe AI's System One model: it answers typed questions with probabilities and writes no text.

chunk-standalone sends each file's chunks in reading order. One request holds up to 8 consecutive chunks
(`--batch`) as the state, plus the last 1,500 characters of the chunk before them and the first 1,500 characters of
the chunk after them, so every chunk is judged next to both neighbours:

```json
{ "chunks": ["[...] end of the chunk before", "chunk 1", "chunk 2", "chunk 3", "start of the chunk after [...]"] }
```

For every chunk in the request it asks three questions, which point at the chunk by its position:

| Question                                                                                                        | Type   | What it decides                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| Can a reader understand `chunks[2]` without the pieces before it?                                               | noul   | whether the chunk needs earlier text                                                     |
| Does `chunks[2]` refer to something that is not inside it, such as "this", "above", "the following", "as mentioned"? | noul   | whether it points outside itself                                                         |
| What should be done with `chunks[2]` so that it reads well on its own?                                          | choice | keep, merge with previous, merge with next, or split (a merge only when that neighbour exists) |

All three are asked for every chunk, 24 questions per request at the default batch size, and the code decides which
answers matter. The full wording is in `src/check.mjs`, and `--dry-run --json` prints every request body.

The verdict is made in code with one threshold, `--threshold` (default 0.8):

| Verdict | When                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ok      | the first answer is at least the threshold, the second at most 1 minus the threshold, and the fix is keep with a confidence of at least the threshold            |
| fix     | the fix is a merge or a split with a confidence of at least the threshold, and a problem is confirmed (first answer at most 1 minus the threshold, or second at least the threshold) or the fix is split |
| review  | everything else: an answer between the two limits, a fix Jev is unsure of, or answers that disagree                                                              |

A split stands on its own because a chunk can make sense alone and still mix two topics. The report prints the
probabilities next to every verdict. Every word in it comes from your files or from fixed text in the code.

## Install

Needs Node.js 20 or later.

```sh
npm install -g github:hamzaahmadaslam/chunk-standalone
```

## Usage

```sh
export TYPESAFE_API_KEY=<your-key>
chunk-standalone docs/
```

In PowerShell, set the key with `$env:TYPESAFE_API_KEY = "<your-key>"`.

```sh
chunk-standalone docs/ --dry-run                  # the chunks, the questions and a token estimate; sends nothing
chunk-standalone docs/ --by paragraph             # split at blank lines instead of headings
chunk-standalone docs/guide.md --by tokens=300    # pieces of about 300 tokens
chunk-standalone chunks.jsonl --json > report.json
chunk-standalone docs/ --threshold 0.9            # stricter: more chunks go to review
```

| Option                             | Default   | What it does                                                                                     |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `--by heading\|paragraph\|tokens=N` | `heading` | How to split Markdown and text files. Ignored for JSONL input.                                   |
| `--threshold <p>`                  | `0.8`     | Confidence needed to mark a chunk ok or fix. Above 0.5, at most 1.                               |
| `--batch <n>`                      | `8`       | Chunks per request, 1 to 50. `--batch 1` sends each chunk with only its own neighbours.          |
| `--timeout <seconds>`              | `10`      | Time limit for each request. Rate limits (429) and overload (529) are retried three times.      |
| `--json`                           | off       | Print JSON: every chunk, its verdict and the raw probabilities.                                  |
| `--dry-run`                        | off       | Print how the files were chunked, one chunk's questions and the token estimate. Needs no key.    |

Environment: `TYPESAFE_API_KEY` (needed unless `--dry-run`) and `TYPESAFE_MODEL` (default `jev-latest`).

Exit codes: `0` when no chunk needs a fix, `1` when at least one does, so it can fail a CI job, and `2` on an error.
Chunks in review do not change the exit code.

### Input

- A folder: every `.md`, `.markdown`, `.mdx` and `.txt` file below it, except inside `node_modules` and folders
  whose names start with a dot. YAML front matter at the top of a Markdown file is skipped.
- One file with one of those extensions.
- A `.jsonl` file of chunks you already made, one per line:

  ```json
  {"id": "install-2", "text": "As shown above, run the installer.", "source": "install.md"}
  ```

  The text may also be in `page_content` or `content`, and the source in `metadata.source` or
  `metadata.file_name`, which covers LangChain-style exports. Chunks are checked in line order within their
  source. Without a source, the whole file counts as one document.

Files are split the three common ways, so the report shows the problems your own chunker is likely to make:

| `--by`      | Splits                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `heading`   | at every heading (`#` to `######`) outside code blocks; text before the first heading is its own chunk     |
| `paragraph` | at every blank line outside code blocks                                                                  |
| `tokens=N`  | into pieces of about N tokens (four characters per token), cut between words, with no overlap            |

If your pipeline adds overlap, titles or heading paths to its chunks, export the chunks to JSONL and check those.

## Example

`examples/docs` holds two short Markdown pages about a made-up backup feature, written for this example. The
probabilities below come from `examples/fixture-answers.json`: they were written by hand for the tests, not
recorded from TypeSafe, and show the report format. Your numbers will differ. `node examples/run.mjs` prints this
report without a key or a network call.

```text
chunk-standalone: 9 chunks in 2 files, split by heading
Model jev-1.13.0, 2 requests, 3,695 input tokens, threshold 0.8

ok 4   fix 4   review 1

backups.md (5 chunks: fix 3, review 1)
  #2 line 10  review (unclear if it stands alone, unclear if it points outside itself, unclear which fix)
      standalone 0.46 | outside reference 0.38 | fix answer: merge with previous 0.55, keep 0.41 (confidence 0.40)
      "## Schedule It starts at 02:00 server time and usually takes a few..."
  #3 line 14  fix: merge with previous (needs earlier text, points outside itself)
      standalone 0.14 | outside reference 0.93 | fix answer: merge with previous 0.91, keep 0.05 (confidence 0.88)
      "## Keeping copies As shown above, a copy is made every night. Copies..."
  #4 line 19  fix: merge with next (points outside itself)
      standalone 0.35 | outside reference 0.95 | fix answer: merge with next 0.92 (confidence 0.89)
      "## Settings The following settings control the job."
  #5 line 23  fix: split (covers more than one topic)
      standalone 0.84 | outside reference 0.12 | fix answer: split 0.90, keep 0.08 (confidence 0.85)
      "## Settings reference `backup.bucket` is the storage bucket that..."

restore.md (4 chunks: fix 1)
  #3 line 16  fix: merge with previous (needs earlier text, points outside itself)
      standalone 0.11 | outside reference 0.94 | fix answer: merge with previous 0.93 (confidence 0.91)
      "## If it fails Repeat step 2 with maintenance mode switched on. If the..."

fix: confident answers (threshold 0.8) found a problem and agree on the fix.
review: the answers were not confident enough or disagreed. Read these chunks yourself.
```

"As shown above" and "Repeat step 2" point back to earlier chunks, "The following settings" points forward, and
the settings reference mixes backup settings with account emails and invoices. "It starts at 02:00" sits near the
middle on every question, so it goes to review. The same run with `--json` is in `examples/report.json`, and the
dry run in `examples/dry-run.txt`.

## What leaves your machine

Only when you run it with a key and without `--dry-run`, and only to `https://api.typesafe.ai/v1/systemone`:

- the text of your chunks, up to 8 consecutive chunks of one file per request (`--batch`);
- the last 1,500 characters of the chunk before them and the first 1,500 characters of the chunk after them;
- the fixed question text, which names chunks only by position (`chunks[2]`), question ids such as `c12_fix`, and
  the model name;
- your API key, in the `Authorization` header.

File names, folder names, chunk ids, line numbers and other JSONL fields are not sent. The tool writes nothing to
disk and makes no other network requests, for telemetry, updates or anything else.

## Limits

- Jev sees the chunk text and its neighbours, not what your pipeline adds at query time. If you prepend titles or
  heading paths to chunks before embedding, put them in the chunk text (JSONL input) so the check sees what your
  retriever sees.
- The fix is one of four answers. For a chunk that only lacks its section name, adding the heading is often the
  better fix; the report does not suggest it.
- A merge suggestion names one neighbour. A chunk that needs text on both sides gets one of them.
- The splitting modes approximate common chunkers: no overlap, only `#` headings (underlined headings are not
  recognised), and token counts estimated at four characters per token. For your exact chunks, use JSONL.
- English is where Jev is most accurate. The token estimate also assumes English; other scripts use more tokens per
  character, so lower `--batch` if TypeSafe rejects a request as too large.
- Chunks estimated above 14,000 tokens are listed as skipped, not checked.
- Text written to steer a model, such as an instruction hidden in a document, can move Jev's answers.
- The tool reports and never edits files. Treat fix verdicts as suggestions, read the review list yourself, and
  check a sample of verdicts on your own documents before you rely on a threshold.

## Token use

The input tokens of a request are its state (the chunks and the text on either side of them) and its questions. The
questions add about 375 tokens per chunk, so for short chunks most of the input is the questions. By the tool's own
estimate (four characters per token):

| Run                                                         | Requests | Input tokens   |
| ----------------------------------------------------------- | -------- | -------------- |
| The example: 9 chunks in 2 files                            | 2        | about 3,700    |
| 1,000 chunks of about 200 tokens (100 files of 10 sections) | 200      | about 630,000  |
| The same files with `--batch 1`                             | 1,000    | about 980,000  |

`--dry-run` prints the estimate for your own files before anything is sent. After a run, the report prints the input
tokens TypeSafe counted.

## License

MIT. Made by [Hamza Ahmad Aslam](https://hamzaahmadaslam.com), WordPress and web performance engineer.
