// Formats results for people (the report, the dry run) and for programs (JSON). Every word printed comes from the
// input files or from the fixed text in this file; Jev returns only probabilities.
import { describeBy, estimateTokens } from "./chunk.mjs";
import { estimatePlan, PRICE_PER_MILLION } from "./check.mjs";

const FIX_NAMES = {
  keep: "keep",
  merge_with_previous: "merge with previous",
  merge_with_next: "merge with next",
  split: "split",
};
const FIX_ORDER = Object.keys(FIX_NAMES);

const REASONS = {
  needs_earlier_text: "needs earlier text",
  points_outside: "points outside itself",
  mixes_topics: "covers more than one topic",
  unsure_standalone: "unclear if it stands alone",
  unsure_outside: "unclear if it points outside itself",
  unsure_fix: "unclear which fix",
  answers_disagree: "answers disagree",
  no_answer: "no answer from TypeSafe",
  empty: "empty chunk",
  too_large: "too large to check",
};

const LIST_LIMIT = 20;

const count = (n) => n.toLocaleString("en-US");
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
const p2 = (value) => value.toFixed(2);
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** Dollars, with enough decimals to show a cost that is usually a fraction of a cent. */
export function money(cost) {
  if (cost === 0) return "$0";
  if (cost < 0.0001) return "under $0.0001";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/** The start of a chunk on one line, for finding it in the file. */
export function preview(text, max = 76) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}...`;
}

function scope(meta, files) {
  return meta.inputKind === "jsonl"
    ? `${plural(files, "source")}, read from ${meta.jsonlName}`
    : `${plural(files, "file")}, split by ${describeBy(meta.by)}`;
}

function reasonText(entry) {
  return entry.reasons
    .map((reason) =>
      reason === "too_large" ? `${REASONS[reason]}, about ${count(estimateTokens(entry.chunk.text))} tokens` : REASONS[reason] ?? reason,
    )
    .join(", ");
}

function fixAnswer(fix) {
  const ranked = Object.entries(fix.probabilities)
    .filter(([, value]) => typeof value === "number")
    .sort((a, b) => b[1] - a[1] || FIX_ORDER.indexOf(a[0]) - FIX_ORDER.indexOf(b[0]));
  const shown = ranked.filter(([, value], i) => i === 0 || value >= 0.05).slice(0, 3);
  const options = shown.map(([name, value]) => `${FIX_NAMES[name] ?? name} ${p2(value)}`).join(", ");
  return `${options} (confidence ${p2(fix.confidence)})`;
}

function formatEntry(entry) {
  const { chunk, verdict, answer } = entry;
  const where = `  ${chunk.label} line ${chunk.line}`;
  const lines = [
    verdict === "fix" ? `${where}  fix: ${FIX_NAMES[entry.fix]} (${reasonText(entry)})` : `${where}  ${verdict} (${reasonText(entry)})`,
  ];
  if (answer) {
    lines.push(
      `      standalone ${p2(answer.standalone)} | outside reference ${p2(answer.outside)} | fix answer: ${fixAnswer(answer.fix)}`,
    );
  }
  if (chunk.text.trim()) lines.push(`      "${preview(chunk.text)}"`);
  return lines;
}

/** The human-readable report: counts, then the chunks to fix or review, grouped by file, with probabilities. */
export function formatReport(result, meta) {
  const { summary, usage, threshold } = result;
  const cost = (usage.input_tokens * PRICE_PER_MILLION) / 1e6;
  const lines = [
    `chunk-standalone: ${plural(summary.chunks, "chunk")} in ${scope(meta, summary.files)}`,
    `Model ${result.model}, ${plural(usage.requests, "request")}, ${count(usage.input_tokens)} input tokens ` +
      `(about ${money(cost)}), threshold ${threshold}`,
    "",
    `ok ${summary.ok}   fix ${summary.fix}   review ${summary.review}${summary.skipped ? `   skipped ${summary.skipped}` : ""}`,
  ];
  const listed = result.files
    .map((file) => ({ file, entries: file.chunks.filter((entry) => entry.verdict !== "ok") }))
    .filter(({ entries }) => entries.length);
  for (const { file, entries } of listed) {
    const tally = ["fix", "review", "skipped"]
      .map((verdict) => [verdict, entries.filter((entry) => entry.verdict === verdict).length])
      .filter(([, n]) => n)
      .map(([verdict, n]) => `${verdict} ${n}`)
      .join(", ");
    lines.push("", `${file.source} (${plural(file.chunks.length, "chunk")}: ${tally})`);
    for (const entry of entries) lines.push(...formatEntry(entry));
  }
  const quiet = result.files.length - listed.length;
  if (!listed.length) lines.push("", "No chunks to fix or review.");
  else if (quiet) lines.push("", `${plural(quiet, "other file")} had nothing to fix or review.`);
  if (summary.fix || summary.review) {
    lines.push(
      "",
      `fix: confident answers (threshold ${threshold}) found a problem and agree on the fix.`,
      "review: the answers were not confident enough or disagreed. Read these chunks yourself.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The report as JSON: every chunk, its verdict, and the raw probabilities. */
export function toJson(result, meta) {
  const cost = (result.usage.input_tokens * PRICE_PER_MILLION) / 1e6;
  return {
    tool: "chunk-standalone",
    version: meta.version,
    input: meta.inputKind,
    by: meta.inputKind === "jsonl" ? null : describeBy(meta.by),
    threshold: result.threshold,
    batch: meta.batch,
    model: result.model,
    summary: result.summary,
    usage: { ...result.usage, estimated_cost_usd: round6(cost) },
    files: result.files.map((file) => ({
      source: file.source,
      chunks: file.chunks.map(({ chunk, verdict, fix, reasons, answer }) => ({
        id: chunk.id,
        number: chunk.number,
        line: chunk.line,
        estimated_tokens: estimateTokens(chunk.text),
        verdict,
        fix,
        reasons,
        standalone: answer?.standalone ?? null,
        outside_reference: answer?.outside ?? null,
        fix_probabilities: answer?.fix.probabilities ?? null,
        fix_confidence: answer?.fix.confidence ?? null,
        preview: preview(chunk.text),
      })),
    })),
  };
}

/** The first chunk that has both neighbours in its request, to show its questions; else the first chunk. */
function exampleTarget(plan) {
  for (const request of plan.requests) {
    const target = request.targets.find((t) => t.at > 0 && t.at < request.body.state.chunks.length - 1);
    if (target) return { request, target };
  }
  const request = plan.requests[0];
  return request ? { request, target: request.targets[0] } : null;
}

/** What --dry-run prints: how the files were chunked, the requests, the token estimate and one chunk's questions. */
export function formatDryRun(plan, meta) {
  const estimate = estimatePlan(plan);
  const lines = [
    "Dry run: nothing was sent to TypeSafe.",
    "",
    `${plural(plan.chunkCount, "chunk")} in ${scope(meta, plan.documents.length)}`,
  ];
  const shown = plan.documents.slice(0, LIST_LIMIT);
  const width = Math.max(...shown.map((doc) => doc.source.length));
  for (const doc of shown) {
    const sizes = doc.chunks.map((chunk) => estimateTokens(chunk.text));
    const range = sizes.length ? `, ${count(Math.min(...sizes))} to ${count(Math.max(...sizes))} tokens each` : "";
    lines.push(`  ${doc.source.padEnd(width)}  ${plural(doc.chunks.length, "chunk")}${range}`);
  }
  if (plan.documents.length > shown.length) lines.push(`  and ${plural(plan.documents.length - shown.length, "more file")}`);
  for (const { source, chunk, reason } of plan.skipped) {
    lines.push(`Skipped ${source} ${chunk.label} line ${chunk.line}: ${reasonText({ chunk, reasons: [reason] })}`);
  }
  lines.push(
    "",
    `${plural(plan.requests.length, "request")} to ${meta.model}, about ${count(estimate.tokens)} input tokens ` +
      `(${money(estimate.cost)} at $${PRICE_PER_MILLION} per million)`,
  );
  const example = exampleTarget(plan);
  if (example) {
    const { request, target } = example;
    lines.push("", `Each chunk gets three questions. For ${request.source} ${target.chunk.label}, which is \`chunks[${target.at}]\` in its request:`);
    for (const suffix of ["standalone", "outside", "fix"]) {
      const id = `${target.key}_${suffix}`;
      const question = request.body.questions[id];
      const options = question.type === "choice" ? `: ${Object.keys(question.criteria).join(", ")}` : "";
      lines.push(`  ${id} (${question.type}${options})`, `    ${question.instructions}`);
    }
  }
  lines.push("", "Run with --dry-run --json to see every request body.");
  return `${lines.join("\n")}\n`;
}

/** What --dry-run --json prints: the estimate and every request body exactly as it would be sent. */
export function dryRunJson(plan, meta) {
  const estimate = estimatePlan(plan);
  return {
    tool: "chunk-standalone",
    version: meta.version,
    dry_run: true,
    input: meta.inputKind,
    by: meta.inputKind === "jsonl" ? null : describeBy(meta.by),
    batch: meta.batch,
    model: meta.model,
    summary: {
      files: plan.documents.length,
      chunks: plan.chunkCount,
      requests: plan.requests.length,
      skipped: plan.skipped.length,
    },
    estimated_input_tokens: estimate.tokens,
    estimated_cost_usd: round6(estimate.cost),
    skipped: plan.skipped.map(({ source, chunk, reason }) => ({
      source,
      id: chunk.id,
      line: chunk.line,
      reason,
      estimated_tokens: estimateTokens(chunk.text),
    })),
    requests: plan.requests.map((request, i) => ({
      source: request.source,
      chunks: request.targets.map((target) => target.chunk.id),
      estimated_tokens: estimate.perRequest[i],
      body: request.body,
    })),
  };
}
