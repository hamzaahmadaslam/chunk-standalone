// Builds the requests (consecutive chunks of one document as the state, three questions per chunk), sends them to
// Jev, and turns the answers into a verdict for each chunk: ok, fix or review. The thresholds live here, in code.
import { estimateTokens } from "./chunk.mjs";
import { askJev, choice, DEFAULT_MODEL, noul } from "./jev.mjs";

export const DEFAULT_THRESHOLD = 0.8;
export const DEFAULT_BATCH = 8;
export const MAX_BATCH = 50;
export const DEFAULT_TIMEOUT_SECONDS = 10;
/** Estimated tokens of state per request. TypeSafe allows 32k for the state plus the longest question. */
export const STATE_BUDGET = 16_000;
/** How much of a neighbour outside the batch goes into the state: the end of the one before, the start of the one after. */
export const CONTEXT_CHARS = 1_500;
/** Chunks estimated above this many tokens are reported as too large and not sent. */
export const MAX_CHUNK_TOKENS = 14_000;
/** US dollars per million input tokens for jev-1.13. Output tokens are free. */
export const PRICE_PER_MILLION = 0.042;
const CONCURRENCY = 4;

const ORDER = "`chunks` lists consecutive pieces of one document, in reading order.";

/**
 * The three questions asked about the chunk at `chunks[at]` in the state. `key` prefixes the question ids; the ids
 * are for this code only. The merge options are offered only when that neighbour is in the state.
 */
export function questionsFor(key, at, { hasPrevious, hasNext }) {
  const self = `\`chunks[${at}]\``;
  const previous = `\`chunks[${at - 1}]\``;
  const next = `\`chunks[${at + 1}]\``;
  const fixes = { keep: "Keep it as it is: it makes sense on its own and covers one topic." };
  if (hasPrevious) fixes.merge_with_previous = `Join it to ${previous}: it continues ${previous} or needs it to make sense.`;
  if (hasNext) {
    fixes.merge_with_next = `Join it to ${next}: it is only a heading or an introduction for ${next}, or it leads into a list or example in ${next}.`;
  }
  fixes.split = "Split it: it covers two or more separate topics.";
  return {
    [`${key}_standalone`]: noul(
      `${ORDER} A search system will return ${self} alone. Can a reader understand ${self} without the pieces before it?`,
      {
        true: "It says what it is about, and every sentence in it makes sense without earlier text.",
        false:
          "It continues a sentence, list, table, code block or explanation from earlier text, or what it is about is only named in earlier text.",
      },
    ),
    [`${key}_outside`]: noul(
      `Does ${self} refer to something that is not inside ${self}, with words such as "this", "above", "below", "the following", "as mentioned" or "the previous step"?`,
      {
        true: "It points to a passage, list, table, figure, step or section that is outside it.",
        false: "It points to nothing outside itself, or what it points to is inside it.",
      },
    ),
    [`${key}_fix`]: choice(
      `${ORDER} A search system will return ${self} alone. What should be done with ${self} so that it reads well on its own?`,
      fixes,
    ),
  };
}

/** Why a chunk cannot be sent, or null when it can. */
function skipReason(chunk) {
  if (!chunk.text.trim()) return "empty";
  if (estimateTokens(chunk.text) > MAX_CHUNK_TOKENS) return "too_large";
  return null;
}

/** Tokens a text takes up inside the JSON state, quotes and escapes included. */
const stateTokens = (text) => estimateTokens(JSON.stringify(text));
const CONTEXT_TOKENS = 2 * stateTokens(`[...] ${"x".repeat(CONTEXT_CHARS)}`);

/** The end of a neighbour chunk, cut at a word boundary and marked with [...]. */
function tail(text) {
  if (text.length <= CONTEXT_CHARS) return text;
  const cut = text.slice(-CONTEXT_CHARS);
  const space = cut.search(/\s/);
  return `[...] ${(space >= 0 ? cut.slice(space) : cut).trim()}`;
}

/** The start of a neighbour chunk, cut at a word boundary and marked with [...]. */
function head(text) {
  if (text.length <= CONTEXT_CHARS) return text;
  const cut = text.slice(0, CONTEXT_CHARS);
  const space = cut.search(/\s\S*$/);
  return `${(space > 0 ? cut.slice(0, space) : cut).trim()} [...]`;
}

/**
 * Groups the chunks of each document into requests. A request holds up to `batch` consecutive chunks, plus the end
 * of the chunk before them and the start of the chunk after them, so every checked chunk has both neighbours in the
 * state. Empty chunks and chunks over MAX_CHUNK_TOKENS are listed in `skipped` instead.
 */
export function planRequests(documents, { batch = DEFAULT_BATCH, model = DEFAULT_MODEL } = {}) {
  const requests = [];
  const skipped = [];
  let counter = 0;
  for (const doc of documents) {
    const { chunks } = doc;
    const numbers = chunks.map(() => counter++);
    let i = 0;
    while (i < chunks.length) {
      const reason = skipReason(chunks[i]);
      if (reason) {
        skipped.push({ source: doc.source, chunk: chunks[i], reason });
        i++;
        continue;
      }
      const asked = [i];
      let tokens = CONTEXT_TOKENS + stateTokens(chunks[i].text);
      let j = i + 1;
      while (j < chunks.length && asked.length < batch && !skipReason(chunks[j])) {
        const more = stateTokens(chunks[j].text);
        if (tokens + more > STATE_BUDGET) break;
        tokens += more;
        asked.push(j++);
      }
      requests.push(buildRequest(doc, asked, numbers, model));
      i = j;
    }
  }
  return { documents, requests, skipped, chunkCount: counter };
}

function buildRequest(doc, asked, numbers, model) {
  const { chunks } = doc;
  const items = [];
  const before = chunks[asked[0] - 1];
  if (before?.text.trim()) items.push(tail(before.text));
  const offset = items.length;
  for (const k of asked) items.push(chunks[k].text);
  const after = chunks[asked[asked.length - 1] + 1];
  if (after?.text.trim()) items.push(head(after.text));
  const questions = {};
  const targets = asked.map((k, index) => {
    const at = offset + index;
    const key = `c${numbers[k]}`;
    Object.assign(questions, questionsFor(key, at, { hasPrevious: at > 0, hasNext: at < items.length - 1 }));
    return { key, at, chunk: chunks[k] };
  });
  return { source: doc.source, targets, body: { model, state: { chunks: items }, questions } };
}

/** Estimated input tokens and cost of a plan, for --dry-run. */
export function estimatePlan(plan) {
  const perRequest = plan.requests.map((request) => estimateTokens(JSON.stringify(request.body)));
  const tokens = perRequest.reduce((sum, n) => sum + n, 0);
  return { perRequest, tokens, cost: (tokens * PRICE_PER_MILLION) / 1e6 };
}

const isProbability = (value) => typeof value === "number" && value >= 0 && value <= 1;

/** The three answers for one chunk from a response, or null when any is missing or malformed. */
export function readAnswer(answers, key) {
  const standalone = answers?.[`${key}_standalone`]?.noul;
  const outside = answers?.[`${key}_outside`]?.noul;
  const fix = answers?.[`${key}_fix`];
  if (!isProbability(standalone) || !isProbability(outside)) return null;
  if (typeof fix?.choice !== "string" || !isProbability(fix.confidence)) return null;
  if (!fix.probabilities || typeof fix.probabilities !== "object") return null;
  return { standalone, outside, fix: { choice: fix.choice, confidence: fix.confidence, probabilities: fix.probabilities } };
}

// Rounding keeps float noise (1 - 0.8 is 0.19999999999999996) from moving an answer that sits on the threshold.
const round = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Turns one chunk's answers into a verdict. A yes/no answer counts only at or above `threshold` (yes) or at or
 * below 1 - `threshold` (no), and the fix answer only when its confidence is at or above `threshold`.
 *   ok:     it stands alone, points to nothing outside itself, and the fix is keep.
 *   fix:    the fix is merge or split, and either a problem is confirmed or the fix is split (a chunk can make
 *           sense alone and still cover two topics).
 *   review: anything else, with the reasons.
 */
export function decide(answer, threshold = DEFAULT_THRESHOLD) {
  const { standalone, outside, fix } = answer;
  const standsAlone = round(standalone) >= threshold;
  const needsEarlier = round(1 - standalone) >= threshold;
  const pointsOut = round(outside) >= threshold;
  const selfContained = round(1 - outside) >= threshold;
  const fixSure = round(fix.confidence) >= threshold;
  const clean = standsAlone && selfContained;
  const problem = needsEarlier || pointsOut;

  if (clean && fixSure && fix.choice === "keep") return { verdict: "ok", fix: "keep", reasons: [] };
  if (fixSure && fix.choice !== "keep" && (problem || fix.choice === "split")) {
    const reasons = [];
    if (needsEarlier) reasons.push("needs_earlier_text");
    if (pointsOut) reasons.push("points_outside");
    if (fix.choice === "split") reasons.push("mixes_topics");
    return { verdict: "fix", fix: fix.choice, reasons };
  }
  const reasons = [];
  if (!standsAlone && !needsEarlier) reasons.push("unsure_standalone");
  if (!pointsOut && !selfContained) reasons.push("unsure_outside");
  if (!fixSure) reasons.push("unsure_fix");
  else if ((fix.choice === "keep" && problem) || (fix.choice !== "keep" && clean)) reasons.push("answers_disagree");
  return { verdict: "review", fix: fix.choice, reasons: reasons.length ? reasons : ["answers_disagree"] };
}

/** Runs `worker` over `items` with at most `limit` at a time; stops starting new work after the first failure. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Sends every request in the plan (four at a time) and returns the verdicts grouped by document:
 * { model, threshold, files: [{ source, chunks: [{ chunk, verdict, fix, reasons, answer }] }], summary, usage }.
 * Any TypeSafe error (missing key, 401, 422, 429 or 529 after retries, timeout) stops the run with a JevError.
 */
export async function runPlan(plan, options = {}) {
  const {
    threshold = DEFAULT_THRESHOLD,
    apiKey,
    model = DEFAULT_MODEL,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    retries = 3,
    fetchImpl,
    onProgress,
  } = options;
  let done = 0;
  const responses = await mapLimit(plan.requests, CONCURRENCY, async (request) => {
    const response = await askJev(request.body.state, request.body.questions, {
      apiKey,
      model,
      timeoutMs: timeoutSeconds * 1000,
      retries,
      fetchImpl,
    });
    onProgress?.(++done, plan.requests.length);
    return response;
  });

  const outcomes = new Map();
  plan.requests.forEach((request, i) => {
    for (const { key, chunk } of request.targets) {
      const answer = readAnswer(responses[i].answers, key);
      outcomes.set(
        chunk,
        answer ? { answer, ...decide(answer, threshold) } : { answer: null, verdict: "review", fix: null, reasons: ["no_answer"] },
      );
    }
  });
  for (const { chunk, reason } of plan.skipped) {
    outcomes.set(chunk, { answer: null, verdict: "skipped", fix: null, reasons: [reason] });
  }

  const files = plan.documents.map((doc) => ({
    source: doc.source,
    chunks: doc.chunks.map((chunk) => ({ chunk, ...outcomes.get(chunk) })),
  }));
  const summary = { files: files.length, chunks: plan.chunkCount, ok: 0, fix: 0, review: 0, skipped: 0 };
  for (const file of files) for (const entry of file.chunks) summary[entry.verdict]++;
  const usage = {
    requests: responses.length,
    input_tokens: responses.reduce((sum, r) => sum + (Number(r.usage?.input_tokens) || 0), 0),
    output_tokens: responses.reduce((sum, r) => sum + (Number(r.usage?.output_tokens) || 0), 0),
  };
  return { model: responses[0]?.model ?? model, threshold, files, summary, usage };
}
