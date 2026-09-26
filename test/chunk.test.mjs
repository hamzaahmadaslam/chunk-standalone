import assert from "node:assert/strict";
import test from "node:test";
import {
  blankFrontMatter,
  chunkByHeading,
  chunkByParagraph,
  chunkByTokens,
  estimateTokens,
  parseBy,
} from "../src/chunk.mjs";

// Any accidental network call fails loudly instead of reaching TypeSafe.
globalThis.fetch = () => {
  throw new Error("Tests must not use the network.");
};

const DOC = [
  "Intro before any heading.",
  "",
  "# Title",
  "First section.",
  "",
  "```sh",
  "# a shell comment, not a heading",
  "",
  "echo done",
  "```",
  "",
  "## Next",
  "",
  "Second section.",
].join("\n");

test("heading mode starts a chunk at each heading, keeps the heading, and ignores # inside code fences", () => {
  assert.deepEqual(chunkByHeading(DOC), [
    { line: 1, text: "Intro before any heading." },
    { line: 3, text: "# Title\nFirst section.\n\n```sh\n# a shell comment, not a heading\n\necho done\n```" },
    { line: 12, text: "## Next\n\nSecond section." },
  ]);
  assert.deepEqual(chunkByHeading("# A\r\nWindows line endings.\r\n"), [{ line: 1, text: "# A\nWindows line endings." }]);
  assert.deepEqual(chunkByHeading("#hashtag is not a heading\n####### nor is this"), [
    { line: 1, text: "#hashtag is not a heading\n####### nor is this" },
  ]);
  // A backtick fence cannot have a backtick after it on its line, so this is inline code and # B is a heading.
  assert.deepEqual(chunkByHeading("# A\n```inline``` code.\n# B\nText."), [
    { line: 1, text: "# A\n```inline``` code." },
    { line: 3, text: "# B\nText." },
  ]);
  // A tilde fence may have backticks after it.
  assert.deepEqual(chunkByHeading("~~~ `info`\n# inside the fence\n~~~\n# B"), [
    { line: 1, text: "~~~ `info`\n# inside the fence\n~~~" },
    { line: 4, text: "# B" },
  ]);
});

test("paragraph mode splits at blank lines but keeps a fenced code block in one chunk", () => {
  assert.deepEqual(chunkByParagraph(DOC), [
    { line: 1, text: "Intro before any heading." },
    { line: 3, text: "# Title\nFirst section." },
    { line: 6, text: "```sh\n# a shell comment, not a heading\n\necho done\n```" },
    { line: 12, text: "## Next" },
    { line: 14, text: "Second section." },
  ]);
});

test("tokens mode cuts between words, stays within N tokens, loses no words and keeps line numbers", () => {
  const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
  const text = `${words.slice(0, 150).join(" ")}\n\n${words.slice(150).join("\n")}`;
  const chunks = chunkByTokens(text, 50);
  assert.ok(chunks.length > 5);
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk.text) <= 50, `a chunk of ${estimateTokens(chunk.text)} tokens`);
    const first = chunk.text.split(/\s+/)[0];
    assert.equal(chunk.line, text.slice(0, text.indexOf(first)).split("\n").length, `line of ${first}`);
  }
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.text.split(/\s+/)),
    words,
  );
});

test("front matter is blanked, so it is not a chunk, and line numbers still match the file", () => {
  const text = "---\ntitle: Example\ntags: [a, b]\n---\n\n# Heading\nBody.";
  const blanked = blankFrontMatter(text);
  assert.equal(blanked.split("\n").length, text.split("\n").length);
  assert.deepEqual(chunkByHeading(blanked), [{ line: 6, text: "# Heading\nBody." }]);
  assert.equal(blankFrontMatter("# No front matter\n---\nText"), "# No front matter\n---\nText");
  assert.equal(blankFrontMatter("---\nnever closed"), "---\nnever closed");
});

test("--by accepts heading, paragraph and tokens=N, and explains anything else", () => {
  assert.deepEqual(parseBy("heading"), { mode: "heading" });
  assert.deepEqual(parseBy("Paragraph"), { mode: "paragraph" });
  assert.deepEqual(parseBy("tokens=300"), { mode: "tokens", size: 300 });
  for (const bad of ["tokens=5", "tokens=abc", "tokens=99999", "sentence", ""]) {
    assert.throws(
      () => parseBy(bad),
      (error) => error.name === "UserError" && error.message.startsWith("--by must be heading, paragraph or tokens=N"),
      bad,
    );
  }
});
