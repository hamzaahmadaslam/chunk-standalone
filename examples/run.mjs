// Reproduces the README example without a TypeSafe key: runs chunk-standalone on examples/docs and answers every
// question from the hand-written probabilities in fixture-answers.json. Nothing leaves the machine.
//   node examples/run.mjs              the report (examples/report.txt)
//   node examples/run.mjs --json       the JSON (examples/report.json)
//   node examples/run.mjs --dry-run    the dry run (examples/dry-run.txt)
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { estimateTokens, parseBy } from "../src/chunk.mjs";
import { main } from "../src/cli.mjs";
import { fixtureFetch } from "../src/jev.mjs";
import { loadInput } from "../src/load.mjs";

export const DOCS = fileURLToPath(new URL("./docs", import.meta.url));
const FIXTURE = JSON.parse(readFileSync(new URL("./fixture-answers.json", import.meta.url), "utf8"));

/** A choice answer shaped like TypeSafe's, with the confidence approximation from TypeSafe's confidence page. */
function choiceAnswer(probabilities, options) {
  const offered = Object.fromEntries(options.map((option) => [option, probabilities[option] ?? 0]));
  const total = Object.values(offered).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 0.001) throw new Error(`Fixture probabilities for ${options.join(", ")} add up to ${total}.`);
  const choice = options.reduce((best, option) => (offered[option] > offered[best] ? option : best));
  const k = options.length;
  const confidence = Math.min(1, Math.max(0, (k * offered[choice] - 1) / (k - 1)));
  return { type: "choice", choice, probabilities: offered, confidence: Math.round(confidence * 100) / 100 };
}

/** A fetch stand-in that answers from fixture-answers.json. The number in each question id picks the chunk. */
export function exampleFetch() {
  const ids = loadInput(DOCS, parseBy("heading")).flatMap((doc) => doc.chunks.map((chunk) => chunk.id));
  return fixtureFetch((body) => {
    const answers = {};
    for (const [key, question] of Object.entries(body.questions)) {
      const [, number, kind] = /^c(\d+)_(standalone|outside|fix)$/.exec(key);
      const fixture = FIXTURE.answers[ids[Number(number)]];
      if (!fixture) throw new Error(`No fixture answer for ${ids[Number(number)]}.`);
      answers[key] =
        kind === "fix" ? choiceAnswer(fixture.fix, Object.keys(question.criteria)) : { type: "noul", noul: fixture[kind] };
    }
    return { model: FIXTURE.model, answers, usage: { input_tokens: estimateTokens(JSON.stringify(body)), output_tokens: 0 } };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2).filter((flag) => flag === "--json" || flag === "--dry-run");
  process.exitCode = await main([DOCS, ...flags], {
    env: { TYPESAFE_API_KEY: "fixture" },
    fetchImpl: exampleFetch().fetchImpl,
  });
}
