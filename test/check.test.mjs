import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "../src/chunk.mjs";
import { CONTEXT_CHARS, decide, planRequests, runPlan, STATE_BUDGET } from "../src/check.mjs";
import { fixtureFetch } from "../src/jev.mjs";

globalThis.fetch = () => {
  throw new Error("Tests must not use the network.");
};

/** A document as the loader returns it. */
const doc = (source, texts) => ({
  source,
  chunks: texts.map((text, i) => ({ id: `${source}#${i + 1}`, label: `#${i + 1}`, number: i + 1, line: i + 1, text })),
});

const ORDER = "`chunks` lists consecutive pieces of one document, in reading order.";
const STANDALONE_CRITERIA = {
  true: "It says what it is about, and every sentence in it makes sense without earlier text.",
  false:
    "It continues a sentence, list, table, code block or explanation from earlier text, or what it is about is only named in earlier text.",
};
const OUTSIDE_CRITERIA = {
  true: "It points to a passage, list, table, figure, step or section that is outside it.",
  false: "It points to nothing outside itself, or what it points to is inside it.",
};

test("the request body: the chunks with their neighbours as state, three questions per chunk", () => {
  const plan = planRequests([doc("guide.md", ["# Setup\nInstall the tool.", "As shown above, run it."])], {
    batch: 8,
    model: "jev-latest",
  });
  assert.equal(plan.requests.length, 1);
  assert.deepEqual(plan.requests[0].body, {
    model: "jev-latest",
    state: { chunks: ["# Setup\nInstall the tool.", "As shown above, run it."] },
    questions: {
      c0_standalone: {
        type: "noul",
        instructions: `${ORDER} A search system will return \`chunks[0]\` alone. Can a reader understand \`chunks[0]\` without the pieces before it?`,
        criteria: STANDALONE_CRITERIA,
      },
      c0_outside: {
        type: "noul",
        instructions:
          'Does `chunks[0]` refer to something that is not inside `chunks[0]`, with words such as "this", "above", "below", "the following", "as mentioned" or "the previous step"?',
        criteria: OUTSIDE_CRITERIA,
      },
      c0_fix: {
        type: "choice",
        instructions: `${ORDER} A search system will return \`chunks[0]\` alone. What should be done with \`chunks[0]\` so that it reads well on its own?`,
        criteria: {
          keep: "Keep it as it is: it makes sense on its own and covers one topic.",
          merge_with_next:
            "Join it to `chunks[1]`: it is only a heading or an introduction for `chunks[1]`, or it leads into a list or example in `chunks[1]`.",
          split: "Split it: it covers two or more separate topics.",
        },
      },
      c1_standalone: {
        type: "noul",
        instructions: `${ORDER} A search system will return \`chunks[1]\` alone. Can a reader understand \`chunks[1]\` without the pieces before it?`,
        criteria: STANDALONE_CRITERIA,
      },
      c1_outside: {
        type: "noul",
        instructions:
          'Does `chunks[1]` refer to something that is not inside `chunks[1]`, with words such as "this", "above", "below", "the following", "as mentioned" or "the previous step"?',
        criteria: OUTSIDE_CRITERIA,
      },
      c1_fix: {
        type: "choice",
        instructions: `${ORDER} A search system will return \`chunks[1]\` alone. What should be done with \`chunks[1]\` so that it reads well on its own?`,
        criteria: {
          keep: "Keep it as it is: it makes sense on its own and covers one topic.",
          merge_with_previous: "Join it to `chunks[0]`: it continues `chunks[0]` or needs it to make sense.",
          split: "Split it: it covers two or more separate topics.",
        },
      },
    },
  });
});

test("batching: at most --batch chunks per request, each asked once, trimmed neighbours at the edges", () => {
  const texts = Array.from({ length: 7 }, (_, i) => `Chunk ${i + 1}. ${"word ".repeat(400)}end.`);
  const plan = planRequests([doc("a.md", texts), doc("b.md", ["Only chunk."])], { batch: 3 });
  assert.deepEqual(
    plan.requests.map((request) => request.targets.map((target) => target.chunk.id)),
    [["a.md#1", "a.md#2", "a.md#3"], ["a.md#4", "a.md#5", "a.md#6"], ["a.md#7"], ["b.md#1"]],
  );
  const [first, second, third, fourth] = plan.requests;
  const items = (request) => request.body.state.chunks;

  // No chunk before a.md#1, so the state opens with it; the start of a.md#4 closes it.
  assert.equal(items(first).length, 4);
  assert.equal(items(first)[0], texts[0]);
  assert.ok(items(first)[3].startsWith("Chunk 4. word") && items(first)[3].endsWith(" [...]"));
  assert.ok(items(first)[3].length <= CONTEXT_CHARS + 6);
  // The end of a.md#3 opens the second request, so its chunks sit at positions 1 to 3.
  assert.ok(items(second)[0].startsWith("[...] ") && items(second)[0].endsWith("word end."));
  assert.deepEqual(items(second).slice(1, 4), texts.slice(3, 6));
  assert.deepEqual(
    second.targets.map((target) => target.at),
    [1, 2, 3],
  );
  // The merge options are offered only where that neighbour is in the state.
  const options = (request, key) => Object.keys(request.body.questions[`${key}_fix`].criteria);
  assert.deepEqual(options(first, "c0"), ["keep", "merge_with_next", "split"]);
  assert.deepEqual(options(second, "c4"), ["keep", "merge_with_previous", "merge_with_next", "split"]);
  assert.deepEqual(options(third, "c6"), ["keep", "merge_with_previous", "split"]);
  assert.deepEqual(options(fourth, "c7"), ["keep", "split"]);
  // Question ids are numbered across the whole run, three per chunk.
  assert.deepEqual(Object.keys(fourth.body.questions), ["c7_standalone", "c7_outside", "c7_fix"]);
  assert.equal(Object.keys(second.body.questions).length, 9);
});

test("the state stays under the token budget; empty and oversized chunks are skipped, not sent", () => {
  const medium = "word ".repeat(6_000); // about 7,500 tokens
  const huge = "word ".repeat(12_000); // about 15,000 tokens, over the limit
  const plan = planRequests([doc("a.md", [medium, medium, medium, huge, "Small chunk."])], { batch: 8 });
  assert.deepEqual(
    plan.requests.map((request) => request.targets.map((target) => target.chunk.id)),
    [["a.md#1", "a.md#2"], ["a.md#3"], ["a.md#5"]],
  );
  assert.deepEqual(
    plan.skipped.map((entry) => [entry.chunk.id, entry.reason]),
    [["a.md#4", "too_large"]],
  );
  for (const request of plan.requests) assert.ok(estimateTokens(JSON.stringify(request.body.state)) <= STATE_BUDGET);
  // The oversized chunk still gives its neighbours context, trimmed.
  assert.ok(plan.requests[1].body.state.chunks.at(-1).endsWith(" [...]"));
  assert.ok(plan.requests[2].body.state.chunks[0].startsWith("[...] "));

  const withEmpty = planRequests([doc("c.jsonl", ["One.", "  ", "Three."])]);
  assert.deepEqual(
    withEmpty.skipped.map((entry) => [entry.chunk.id, entry.reason]),
    [["c.jsonl#2", "empty"]],
  );
  assert.deepEqual(
    withEmpty.requests.map((request) => request.body.state.chunks),
    [["One."], ["Three."]],
  );
});

const answer = (standalone, outside, choice, confidence) => ({
  standalone,
  outside,
  fix: { choice, confidence, probabilities: { [choice]: confidence } },
});

test("decide: ok, fix and review at, above and below the threshold", () => {
  // Exactly at the threshold counts: 0.8 is a yes, 0.2 is a no, a confidence of 0.8 is enough.
  assert.deepEqual(decide(answer(0.8, 0.2, "keep", 0.8), 0.8), { verdict: "ok", fix: "keep", reasons: [] });
  assert.deepEqual(decide(answer(0.95, 0.03, "keep", 0.97), 0.8), { verdict: "ok", fix: "keep", reasons: [] });
  // Just below the threshold goes to review.
  assert.deepEqual(decide(answer(0.79, 0.2, "keep", 0.8), 0.8), {
    verdict: "review",
    fix: "keep",
    reasons: ["unsure_standalone"],
  });
  assert.deepEqual(decide(answer(0.8, 0.21, "keep", 0.8), 0.8), {
    verdict: "review",
    fix: "keep",
    reasons: ["unsure_outside"],
  });
  assert.deepEqual(decide(answer(0.8, 0.2, "keep", 0.79), 0.8), { verdict: "review", fix: "keep", reasons: ["unsure_fix"] });
  // A confident problem and a confident fix.
  assert.deepEqual(decide(answer(0.2, 0.5, "merge_with_previous", 0.8), 0.8), {
    verdict: "fix",
    fix: "merge_with_previous",
    reasons: ["needs_earlier_text"],
  });
  assert.deepEqual(decide(answer(0.5, 0.9, "merge_with_next", 0.85), 0.8), {
    verdict: "fix",
    fix: "merge_with_next",
    reasons: ["points_outside"],
  });
  assert.deepEqual(decide(answer(0.1, 0.95, "merge_with_previous", 0.9), 0.8), {
    verdict: "fix",
    fix: "merge_with_previous",
    reasons: ["needs_earlier_text", "points_outside"],
  });
  // A chunk can make sense on its own and still cover two topics.
  assert.deepEqual(decide(answer(0.9, 0.1, "split", 0.85), 0.8), { verdict: "fix", fix: "split", reasons: ["mixes_topics"] });
  // The same answers under a stricter threshold go to review.
  assert.equal(decide(answer(0.85, 0.1, "keep", 0.88), 0.8).verdict, "ok");
  assert.equal(decide(answer(0.85, 0.1, "keep", 0.88), 0.9).verdict, "review");
  assert.equal(decide(answer(0.1, 0.95, "merge_with_previous", 0.85), 0.9).verdict, "review");
});

test("decide: answers that disagree or are unsure go to review with the reasons", () => {
  assert.deepEqual(decide(answer(0.1, 0.9, "keep", 0.9)), { verdict: "review", fix: "keep", reasons: ["answers_disagree"] });
  assert.deepEqual(decide(answer(0.95, 0.05, "merge_with_previous", 0.9)), {
    verdict: "review",
    fix: "merge_with_previous",
    reasons: ["answers_disagree"],
  });
  assert.deepEqual(decide(answer(0.5, 0.5, "merge_with_next", 0.3)), {
    verdict: "review",
    fix: "merge_with_next",
    reasons: ["unsure_standalone", "unsure_outside", "unsure_fix"],
  });
  assert.deepEqual(decide(answer(0.1, 0.9, "merge_with_previous", 0.6)), {
    verdict: "review",
    fix: "merge_with_previous",
    reasons: ["unsure_fix"],
  });
});

/** Answers every question from a table keyed by chunk: [standalone, outside, fix, confidence]. */
function tableFetch(table, usage = { input_tokens: 1000, output_tokens: 30 }) {
  return fixtureFetch((body) => {
    const answers = {};
    for (const key of Object.keys(body.questions)) {
      const [chunk, kind] = key.split("_");
      const [standalone, outside, choice, confidence] = table[chunk];
      answers[key] =
        kind === "standalone"
          ? { type: "noul", noul: standalone }
          : kind === "outside"
            ? { type: "noul", noul: outside }
            : { type: "choice", choice, confidence, probabilities: { [choice]: confidence } };
    }
    return { model: "jev-1.13.0", answers, usage };
  });
}

test("runPlan with fixture answers: one request per batch, a verdict and probabilities per chunk, usage summed", async () => {
  const plan = planRequests(
    [doc("guide.md", ["# Setup\nInstall the tool with npm.", "As shown above, run it once.", "## Usage\nRun it on a folder."])],
    { batch: 2 },
  );
  const { fetchImpl, calls } = tableFetch({
    c0: [0.95, 0.04, "keep", 0.93],
    c1: [0.1, 0.94, "merge_with_previous", 0.9],
    c2: [0.6, 0.3, "keep", 0.5],
  });
  const result = await runPlan(plan, { apiKey: "test-key", fetchImpl });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(call.headers.authorization, "Bearer test-key");
    assert.equal(call.body.model, "jev-latest");
  }
  assert.deepEqual(
    result.files[0].chunks.map((entry) => [entry.chunk.id, entry.verdict, entry.fix]),
    [
      ["guide.md#1", "ok", "keep"],
      ["guide.md#2", "fix", "merge_with_previous"],
      ["guide.md#3", "review", "keep"],
    ],
  );
  assert.deepEqual(result.files[0].chunks[1].answer, {
    standalone: 0.1,
    outside: 0.94,
    fix: { choice: "merge_with_previous", confidence: 0.9, probabilities: { merge_with_previous: 0.9 } },
  });
  assert.deepEqual(result.summary, { files: 1, chunks: 3, ok: 1, fix: 1, review: 1, skipped: 0 });
  assert.deepEqual(result.usage, { requests: 2, input_tokens: 2000, output_tokens: 60 });
  assert.equal(result.model, "jev-1.13.0");
});

test("a missing or malformed answer puts the chunk in review instead of failing the run", async () => {
  const plan = planRequests([doc("a.md", ["One.", "Two."])]);
  const { fetchImpl } = fixtureFetch(() => ({
    model: "jev-1.13.0",
    answers: { c0_standalone: { type: "noul", noul: 2 }, c0_outside: { type: "noul", noul: 0.1 } },
    usage: {},
  }));
  const result = await runPlan(plan, { apiKey: "test-key", fetchImpl });
  assert.deepEqual(
    result.files[0].chunks.map((entry) => [entry.verdict, entry.reasons]),
    [
      ["review", ["no_answer"]],
      ["review", ["no_answer"]],
    ],
  );
  assert.deepEqual(result.usage, { requests: 1, input_tokens: 0, output_tokens: 0 });
});
