import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseBy } from "../src/chunk.mjs";
import { loadInput } from "../src/load.mjs";

globalThis.fetch = () => {
  throw new Error("Tests must not use the network.");
};

const HEADING = parseBy("heading");

/** A temporary folder with the given files, removed after the test. */
function folder(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "chunk-standalone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

test("a folder: Markdown and text files below it, in path order, without dot files, dot folders or node_modules", (t) => {
  const root = folder(t, {
    "b.md": "---\ntitle: B\n---\n# B\nText of B.",
    "a/guide.markdown": "# Guide\nText.",
    "notes.txt": "Plain text.\n\nSecond paragraph.",
    "page.mdx": "# Page\nText.",
    "image.png": "not text",
    ".draft.md": "# Hidden file",
    ".hidden/draft.md": "# Hidden",
    "node_modules/pkg/readme.md": "# Package",
  });
  const docs = loadInput(root, HEADING);
  assert.deepEqual(
    docs.map((doc) => doc.source),
    ["a/guide.markdown", "b.md", "notes.txt", "page.mdx"],
  );
  assert.deepEqual(docs[1].chunks, [{ id: "b.md#1", label: "#1", number: 1, line: 4, text: "# B\nText of B." }]);
  assert.equal(loadInput(root, parseBy("paragraph"))[2].chunks.length, 2);
  assert.deepEqual(
    loadInput(path.join(root, "notes.txt"), HEADING).map((doc) => doc.source),
    ["notes.txt"],
  );
});

test("JSONL: text, page_content or content, grouped by source, in line order", (t) => {
  const root = folder(t, {
    "chunks.jsonl": [
      JSON.stringify({ id: "a-1", text: "First chunk of A.", source: "a.md" }),
      JSON.stringify({ id: "b-1", page_content: "First chunk of B.", metadata: { source: "b.md" } }),
      "",
      JSON.stringify({ id: 7, content: "Second chunk of A.", source: "a.md" }),
      JSON.stringify({ text: "No id and no source." }),
    ].join("\r\n"),
  });
  assert.deepEqual(loadInput(path.join(root, "chunks.jsonl"), HEADING), [
    {
      source: "a.md",
      chunks: [
        { id: "a-1", label: "a-1", number: 1, line: 1, text: "First chunk of A." },
        { id: "7", label: "7", number: 2, line: 4, text: "Second chunk of A." },
      ],
    },
    { source: "b.md", chunks: [{ id: "b-1", label: "b-1", number: 1, line: 2, text: "First chunk of B." }] },
    {
      source: "chunks.jsonl",
      chunks: [{ id: "line 5", label: "#1", number: 1, line: 5, text: "No id and no source." }],
    },
  ]);
});

test("bad input gives a plain message with the file and line", (t) => {
  const root = folder(t, {
    "no-text.jsonl": '{"id":"x","text":"ok"}\n{"id":"y"}\n',
    "broken.jsonl": '{"text":"ok"}\n{not json}\n',
    "array.jsonl": "[1, 2]\n",
    "empty/readme.png": "not text",
    "data.csv": "a,b",
  });
  const cases = [
    ["no-text.jsonl", 'no-text.jsonl line 2 has no "text" string (also accepted: "page_content" or "content").'],
    ["broken.jsonl", "broken.jsonl line 2 is not valid JSON."],
    ["array.jsonl", "array.jsonl line 1 is not a JSON object."],
    ["empty", /has no \.md, \.markdown, \.mdx, \.txt files/],
    ["data.csv", /is not a folder, a Markdown or text file \(\.md, \.markdown, \.mdx, \.txt\) or a JSONL file \(\.jsonl, \.ndjson\)\.$/],
    ["missing", /there is no such file or folder/],
  ];
  for (const [name, message] of cases) {
    assert.throws(
      () => loadInput(path.join(root, name), HEADING),
      (error) => error.name === "UserError" && (typeof message === "string" ? error.message === message : message.test(error.message)),
      name,
    );
  }
});
