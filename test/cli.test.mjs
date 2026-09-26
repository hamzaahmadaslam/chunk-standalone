import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DOCS, exampleFetch } from "../examples/run.mjs";
import * as checkModule from "../src/check.mjs";
import { main, USAGE } from "../src/cli.mjs";
import { fixtureFetch } from "../src/jev.mjs";
import * as reportModule from "../src/report.mjs";

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

test("no price anywhere: every output gives token counts only, and the code holds no rate or dollar amount", async () => {
  const env = { TYPESAFE_API_KEY: KEY };
  const [text, json, dry, dryJson] = [
    await run([DOCS], { env, fetchImpl: exampleFetch().fetchImpl }),
    await run([DOCS, "--json"], { env, fetchImpl: exampleFetch().fetchImpl }),
    await run([DOCS, "--dry-run"]),
    await run([DOCS, "--dry-run", "--json"]),
  ].map((output) => output.stdout);
  assert.ok(text.includes("\nModel jev-1.13.0, 2 requests, 3,695 input tokens, threshold 0.8\n"));
  assert.ok(dry.includes("\n2 requests to jev-latest, about 3,695 input tokens\n"));
  for (const output of [text, json, dry, dryJson]) {
    assert.ok(!output.includes("$"), "no dollar sign");
    assert.doesNotMatch(output, /cost|price|usd|per million/i);
  }
  assert.deepEqual(Object.keys(JSON.parse(json).usage), ["requests", "input_tokens", "output_tokens"]);
  assert.equal(JSON.parse(dryJson).estimated_input_tokens, 3695);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.doesNotMatch(readme, /\$\s?\d|per million|^## Cost/im, "the README states no price");

  for (const module of [checkModule, reportModule]) {
    assert.deepEqual(Object.keys(module).filter((name) => /price|cost|money/i.test(name)), []);
  }
  for (const name of readdirSync(new URL("../src/", import.meta.url))) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /price|per million|dollar|_usd\b/i, `src/${name}`);
  }
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

/** A response that gives every chunk in the request the same answers. */
const answerAll = (standalone, outside, fix) => (body) => ({
  model: "jev-1.13.0",
  answers: Object.fromEntries(
    Object.entries(body.questions).map(([key, question]) => [
      key,
      question.type === "noul"
        ? { type: "noul", noul: key.endsWith("_standalone") ? standalone : outside }
        : { type: "choice", ...fix },
    ]),
  ),
  usage: { input_tokens: 1500, output_tokens: 0 },
});
const allOk = answerAll(0.97, 0.03, { choice: "keep", confidence: 0.95, probabilities: { keep: 0.96, split: 0.04 } });

test("exit code 0 and a short report when every chunk is ok", async () => {
  const { fetchImpl } = fixtureFetch(allOk);
  const { code, stdout } = await run([DOCS, "--threshold", "0.9"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl });
  assert.equal(code, 0);
  assert.match(stdout, /Model jev-1\.13\.0, 2 requests, 3,000 input tokens, threshold 0\.9/);
  assert.match(stdout, /ok 9 {3}fix 0 {3}review 0/);
  assert.match(stdout, /No chunks to fix or review\./);
});

test("on a terminal, an error starts on a new line and no progress is written after it", async () => {
  const soon = () => new Promise((resolve) => setTimeout(resolve, 20));
  const io = (respond) => {
    const stderr = { isTTY: true, text: "", write: (text) => (stderr.text += text) };
    return { env: { TYPESAFE_API_KEY: KEY }, stdout: { write() {} }, stderr, fetchImpl: fixtureFetch(respond).fetchImpl };
  };

  // The first request is answered; the second is refused a moment later, while the progress line is open.
  const open = io(async (body, call) => {
    if (call === 1) return allOk(body);
    await soon();
    return 401;
  });
  assert.equal(await main([DOCS], open), 2);
  assert.equal(open.stderr.text, "\rchecked 1 of 2 requests\nchunk-standalone: TypeSafe error: the API key was refused\n");

  // The first request is refused; the second is answered after the error is printed, and adds nothing to it.
  let answered;
  const late = new Promise((resolve) => (answered = resolve));
  const stopped = io(async (body, call) => {
    if (call === 1) return 401;
    await soon();
    answered();
    return allOk(body);
  });
  assert.equal(await main([DOCS], stopped), 2);
  await late;
  await soon();
  assert.equal(stopped.stderr.text, "chunk-standalone: TypeSafe error: the API key was refused\n");
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

  // A folder is split as a folder, even when its name ends in .jsonl.
  const folder = path.join(root, "export.jsonl");
  mkdirSync(folder);
  writeFileSync(path.join(folder, "page.md"), "# Page\n\nText.");
  const asFolder = await run([folder, "--by", "paragraph", "--dry-run"]);
  assert.equal(asFolder.stderr, "");
  assert.match(asFolder.stdout, /^2 chunks in 1 file, split by paragraph$/m);
});

test("JSONL input: the report names sources, and a chunk without an id by its position", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chunk-standalone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "chunks.jsonl");
  writeFileSync(
    file,
    [
      '{"text":"Run the installer. Invoices are emailed on the first of each month.","source":"install.md"}',
      '{"id":"faq-1","text":"chunk-standalone checks each chunk of a document.","source":"faq.md"}',
      '{"text":" ","source":"install.md"}',
    ].join("\n"),
  );
  const split = answerAll(0.9, 0.1, { choice: "split", confidence: 0.9, probabilities: { split: 0.95, keep: 0.05 } });
  const { fetchImpl } = fixtureFetch((body) => (body.state.chunks[0].startsWith("Run the installer.") ? split : allOk)(body));
  const report = await run([file], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl });
  assert.equal(report.code, 1);
  assert.equal(
    report.stdout,
    [
      "chunk-standalone: 3 chunks in 2 sources, read from chunks.jsonl",
      "Model jev-1.13.0, 2 requests, 3,000 input tokens, threshold 0.8",
      "",
      "ok 1   fix 1   review 0   skipped 1",
      "",
      "install.md (2 chunks: fix 1, skipped 1)",
      "  #1 line 1  fix: split (covers more than one topic)",
      "      standalone 0.90 | outside reference 0.10 | fix answer: split 0.95, keep 0.05 (confidence 0.90)",
      '      "Run the installer. Invoices are emailed on the first of each month."',
      "  #2 line 3  skipped (empty chunk)",
      "",
      "1 other source had nothing to fix or review.",
      "",
      "fix: confident answers (threshold 0.8) found a problem and agree on the fix.",
      "review: the answers were not confident enough or disagreed. Read these chunks yourself.",
      "",
    ].join("\n"),
  );
  assert.match((await run([file, "--dry-run"])).stdout, /^Skipped install\.md #2 line 3: empty chunk$/m);

  // A dry run lists the first 20 sources and counts the rest.
  const many = path.join(root, "many.jsonl");
  writeFileSync(many, Array.from({ length: 21 }, (_, i) => JSON.stringify({ text: `Chunk ${i}.`, source: `s${i}.md` })).join("\n"));
  assert.match((await run([many, "--dry-run"])).stdout, /^ {2}and 1 more source$/m);
});
