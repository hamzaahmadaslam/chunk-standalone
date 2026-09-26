// The command line: parses options, loads the input, and prints the report, the JSON or the dry run.
// main() takes its environment, output streams and fetch as arguments, so tests run it without a network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseBy } from "./chunk.mjs";
import {
  DEFAULT_BATCH,
  DEFAULT_THRESHOLD,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_BATCH,
  MAX_TIMEOUT_SECONDS,
  planRequests,
  runPlan,
} from "./check.mjs";
import { UserError } from "./errors.mjs";
import { DEFAULT_MODEL, JevError } from "./jev.mjs";
import { inputKind, loadInput } from "./load.mjs";
import { dryRunJson, formatDryRun, formatReport, toJson } from "./report.mjs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const USAGE = `Usage: chunk-standalone <folder | file.md | chunks.jsonl> [options]

Checks whether each RAG chunk can be understood on its own, and suggests keep, merge or split.

Options:
  --by <mode>          how to split .md and .txt files: heading, paragraph or tokens=N (default heading)
  --threshold <p>      confidence needed to mark a chunk ok or fix, above 0.5 and up to 1 (default ${DEFAULT_THRESHOLD})
  --batch <n>          chunks per request, 1 to ${MAX_BATCH} (default ${DEFAULT_BATCH})
  --timeout <seconds>  time limit for each attempt at a request, up to ${MAX_TIMEOUT_SECONDS} (default ${DEFAULT_TIMEOUT_SECONDS})
  --json               print JSON instead of the report
  --dry-run            print the questions and a token estimate; send nothing
  -h, --help           show this help
  -v, --version        show the version

Environment:
  TYPESAFE_API_KEY     your TypeSafe API key (not needed for --dry-run)
  TYPESAFE_MODEL       the model to use (default ${DEFAULT_MODEL})

Exit codes: 0 no chunk to fix, 1 at least one chunk to fix, 2 error.
`;

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        by: { type: "string" },
        threshold: { type: "string" },
        batch: { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    throw new UserError(`${error.message} Run chunk-standalone --help for the options.`);
  }
  const { values, positionals } = parsed;
  if (values.help || values.version) return { help: values.help, version: values.version };
  if (positionals.length !== 1) {
    throw new UserError("Give one folder, Markdown or text file, or .jsonl file to check. Run chunk-standalone --help for usage.");
  }

  const threshold = values.threshold === undefined ? DEFAULT_THRESHOLD : Number(values.threshold);
  if (!(threshold > 0.5 && threshold <= 1)) {
    throw new UserError(`--threshold must be a number above 0.5 and at most 1, not "${values.threshold}".`);
  }
  const batch = values.batch === undefined ? DEFAULT_BATCH : Number(values.batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) {
    throw new UserError(`--batch must be a whole number from 1 to ${MAX_BATCH}, not "${values.batch}".`);
  }
  const timeoutSeconds = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
  if (!(timeoutSeconds > 0 && timeoutSeconds <= MAX_TIMEOUT_SECONDS)) {
    throw new UserError(
      `--timeout must be a number of seconds above 0 and at most ${MAX_TIMEOUT_SECONDS}, not "${values.timeout}".`,
    );
  }
  return {
    input: positionals[0],
    by: parseBy(values.by ?? "heading"),
    byGiven: values.by !== undefined,
    threshold,
    batch,
    timeoutSeconds,
    json: values.json,
    dryRun: values["dry-run"],
  };
}

/** Runs the tool. Returns the exit code: 0 nothing to fix, 1 at least one chunk to fix, 2 an error. */
export async function main(argv, io = {}) {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch } = io;
  const write = (stream, text) => stream.write(text.endsWith("\n") ? text : `${text}\n`);
  // True while the progress line on a terminal has no newline yet, so an error must start a line of its own.
  let progressOpen = false;
  try {
    const options = parseOptions(argv);
    if (options.help || options.version) {
      write(stdout, options.help ? USAGE : VERSION);
      return 0;
    }

    const jsonl = inputKind(options.input) === "jsonl";
    const documents = loadInput(options.input, options.by);
    if (jsonl && options.byGiven) write(stderr, "chunk-standalone: --by is ignored for JSONL input; its chunks are checked as they are.");
    const model = env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL;
    const meta = {
      version: VERSION,
      inputKind: jsonl ? "jsonl" : "files",
      jsonlName: path.basename(options.input),
      by: options.by,
      batch: options.batch,
      model,
    };
    const plan = planRequests(documents, { batch: options.batch, model });

    if (options.dryRun) {
      write(stdout, options.json ? JSON.stringify(dryRunJson(plan, meta), null, 2) : formatDryRun(plan, meta));
      return 0;
    }

    const apiKey = env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) {
      throw new UserError(
        "TYPESAFE_API_KEY is not set. Get a key at https://typesafe.ai and export it first, or use --dry-run to see what would be sent.",
      );
    }
    const progress = stderr.isTTY
      ? (done, total) => {
          progressOpen = done < total;
          stderr.write(`\rchecked ${done} of ${total} requests${progressOpen ? "" : "\n"}`);
        }
      : undefined;
    const result = await runPlan(plan, {
      threshold: options.threshold,
      apiKey,
      model,
      timeoutSeconds: options.timeoutSeconds,
      fetchImpl,
      onProgress: progress,
    });
    write(stdout, options.json ? JSON.stringify(toJson(result, meta), null, 2) : formatReport(result, meta));
    return result.summary.fix > 0 ? 1 : 0;
  } catch (error) {
    if (progressOpen) stderr.write("\n");
    const known = error instanceof UserError || error instanceof JevError;
    write(stderr, `chunk-standalone: ${known ? error.message : `unexpected error: ${error?.message ?? error}`}`);
    return 2;
  }
}
