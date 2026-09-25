import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DOCS, exampleFetch } from "../examples/run.mjs";
import { main, USAGE } from "../src/cli.mjs";
import { fixtureFetch } from "../src/jev.mjs";

globalThis.fetch = () => {
  throw new Error("Tests must not use the network.");
};

const KEY = "test-key-never-printed";
const example = (name) => readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Runs the CLI in this process with captured output. The default fetch fails, so nothing can reach the network. */
async function run(args, { env = {}, fetchImpl = globalThis.fetch } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    env,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    fetchImpl,
  });
  return { code, stdout, stderr };
}

test("tests cannot reach the network: the global fetch is replaced", async () => {
  await assert.rejects(async () => globalThis.fetch("https://api.typesafe.ai/v1/systemone"), /must not use the network/);
});

test("the example in examples/ reproduces report.txt, report.json and dry-run.txt exactly", async () => {
  const report = await run([DOCS], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: exampleFetch().fetchImpl });
  assert.equal(report.code, 1, "four chunks to fix, so the exit code is 1");
  assert.equal(report.stdout, example("report.txt"));
  assert.equal(report.stderr, "");

  const json = await run([DOCS, "--json"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: exampleFetch().fetchImpl });
  assert.equal(json.stdout, example("report.json"));
  assert.deepEqual(JSON.parse(json.stdout).summary, { files: 2, chunks: 9, ok: 4, fix: 4, review: 1, skipped: 0 });

  const dry = await run([DOCS, "--dry-run"]);
  assert.equal(dry.stdout, example("dry-run.txt"));

  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(readme.includes(example("report.txt")), "the README shows examples/report.txt exactly");
  for (const output of [report, json, dry]) assert.ok(!(output.stdout + output.stderr).includes(KEY), "the key is never printed");
});

test("--dry-run prints the questions and a token estimate without a key and without a request", async () => {
  const { fetchImpl, calls } = fixtureFetch(() => 500);
  const text = await run([DOCS, "--dry-run"], { fetchImpl });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^Dry run: nothing was sent to TypeSafe\./);
  assert.match(text.stdout, /2 requests to jev-latest, about [\d,]+ input tokens/);
  assert.match(text.stdout, /c1_fix \(choice: keep, merge_with_previous, merge_with_next, split\)/);

  const json = await run([DOCS, "--dry-run", "--json"], { env: { TYPESAFE_MODEL: "jev-1.13.0" }, fetchImpl });
  const data = JSON.parse(json.stdout);
  assert.equal(data.dry_run, true);
  assert.equal(data.model, "jev-1.13.0");
  assert.deepEqual(
    data.requests.map((request) => request.chunks),
    [
      ["backups.md#1", "backups.md#2", "backups.md#3", "backups.md#4", "backups.md#5"],
      ["restore.md#1", "restore.md#2", "restore.md#3", "restore.md#4"],
    ],
  );
  assert.equal(data.requests[0].body.model, "jev-1.13.0");
  assert.equal(Object.keys(data.requests[0].body.questions).length, 15);
  assert.equal(data.estimated_input_tokens, data.requests[0].estimated_tokens + data.requests[1].estimated_tokens);
  assert.equal(calls.length, 0);
});

test("exit code 0 and a short report when every chunk is ok", async () => {
  const allOk = fixtureFetch((body) => ({
    model: "jev-1.13.0",
    answers: Object.fromEntries(
      Object.entries(body.questions).map(([key, question]) => [
        key,
        question.type === "noul"
          ? { type: "noul", noul: key.endsWith("_standalone") ? 0.97 : 0.03 }
          : { type: "choice", choice: "keep", confidence: 0.95, probabilities: { keep: 0.96, split: 0.04 } },
      ]),
    ),
    usage: { input_tokens: 1500, output_tokens: 0 },
  }));
  const { code, stdout } = await run([DOCS, "--threshold", "0.9"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: allOk.fetchImpl });
  assert.equal(code, 0);
  assert.match(stdout, /Model jev-1\.13\.0, 2 requests, 3,000 input tokens \(about \$0\.0001\), threshold 0\.9/);
  assert.match(stdout, /ok 9 {3}fix 0 {3}review 0/);
  assert.match(stdout, /No chunks to fix or review\./);
});

test("usage errors and a missing key exit 2 with one plain line and no stack trace", async () => {
  const cases = [
    [[DOCS, "--threshold", "0.4"], '--threshold must be a number above 0.5 and at most 1, not "0.4".'],
    [[DOCS, "--threshold", "high"], /--threshold must be a number above 0\.5/],
    [[DOCS, "--batch", "0"], '--batch must be a whole number from 1 to 50, not "0".'],
    [[DOCS, "--timeout", "0"], '--timeout must be a number of seconds above 0 and at most 600, not "0".'],
    [[DOCS, "--by", "sentences"], /--by must be heading, paragraph or tokens=N/],
    [[DOCS, "--frobnicate"], /Unknown option '--frobnicate'.*Run chunk-standalone --help/],
    [[], /^Give one folder, Markdown or text file, or \.jsonl file to check\./],
    [["no-such-folder"], /Cannot read no-such-folder: there is no such file or folder\./],
    [[DOCS], /^TYPESAFE_API_KEY is not set\./],
  ];
  for (const [args, expected] of cases) {
    const { code, stdout, stderr } = await run(args, { env: { TYPESAFE_API_KEY: "  " } });
    const label = args.join(" ") || "(no arguments)";
    assert.equal(code, 2, label);
    assert.equal(stdout, "", label);
    assert.equal(stderr.split("\n").length, 2, `one line for ${label}`);
    assert.ok(stderr.startsWith("chunk-standalone: "), label);
    const message = stderr.slice("chunk-standalone: ".length).trimEnd();
    if (typeof expected === "string") assert.equal(message, expected, label);
    else assert.match(message, expected, label);
  }
});

test("--help, --version, and --by ignored with a note for JSONL input", async (t) => {
  assert.deepEqual(await run(["--help"]), { code: 0, stdout: USAGE, stderr: "" });
  assert.deepEqual(await run(["-v"]), { code: 0, stdout: "1.0.0\n", stderr: "" });

  const root = mkdtempSync(path.join(os.tmpdir(), "chunk-standalone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "chunks.jsonl");
  writeFileSync(
    file,
    ['{"id":"1","text":"First.","source":"a.md"}', '{"id":"2","text":"Second.","source":"a.md"}', '{"id":"3","text":"Other."}'].join("\n"),
  );
  const { code, stdout, stderr } = await run([file, "--by", "paragraph", "--dry-run"]);
  assert.equal(code, 0);
  assert.equal(stderr, "chunk-standalone: --by is ignored for JSONL input; its chunks are checked as they are.\n");
  assert.match(stdout, /3 chunks in 2 sources, read from chunks\.jsonl/);
});
