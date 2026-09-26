// Reads the input: a folder of Markdown and text files, one such file, or a JSONL file of ready-made chunks.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { blankFrontMatter, chunkText, normalize } from "./chunk.mjs";
import { UserError } from "./errors.mjs";

export const TEXT_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"];
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];
const JSONL_EXTENSIONS = [".jsonl", ".ndjson"];

export function isJsonlPath(inputPath) {
  return JSONL_EXTENSIONS.includes(path.extname(inputPath).toLowerCase());
}

/**
 * How loadInput reads `inputPath`: as a "folder", a "jsonl" file of ready-made chunks, or one Markdown or text "file".
 * A folder is read as a folder even when its name ends in .jsonl.
 */
export function inputKind(inputPath) {
  let stat;
  try {
    stat = statSync(inputPath);
  } catch {
    throw new UserError(`Cannot read ${inputPath}: there is no such file or folder.`);
  }
  if (stat.isDirectory()) return "folder";
  if (isJsonlPath(inputPath)) return "jsonl";
  if (TEXT_EXTENSIONS.includes(path.extname(inputPath).toLowerCase())) return "file";
  throw new UserError(
    `${inputPath} is not a folder, a Markdown or text file (${TEXT_EXTENSIONS.join(", ")}) ` +
      `or a JSONL file (${JSONL_EXTENSIONS.join(", ")}).`,
  );
}

/**
 * Loads the input and returns documents in a stable order:
 * [{ source, chunks: [{ id, label, number, line, text }] }], where `number` is the chunk's position in its document
 * (from 1), `label` is how the report names the chunk (`#number`, or the id given in JSONL) and `line` is the line of
 * the file (or of the JSONL file) where the chunk starts.
 */
export function loadInput(inputPath, by) {
  const kind = inputKind(inputPath);
  if (kind === "folder") return loadFolder(inputPath, by);
  if (kind === "jsonl") return loadJsonl(inputPath);
  return [loadFile(inputPath, path.basename(inputPath), by)];
}

/**
 * Every Markdown and text file below `root`, skipping node_modules, files and folders whose names start with a dot,
 * and symbolic links.
 */
export function listTextFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && TEXT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  };
  walk(root);
  return found
    .map((full) => ({ full, source: path.relative(root, full).split(path.sep).join("/") }))
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

function loadFolder(root, by) {
  const files = listTextFiles(root);
  if (!files.length) throw new UserError(`${root} has no ${TEXT_EXTENSIONS.join(", ")} files.`);
  return files.map(({ full, source }) => loadFile(full, source, by));
}

function loadFile(full, source, by) {
  let text = normalize(readFileSync(full, "utf8"));
  if (MARKDOWN_EXTENSIONS.includes(path.extname(full).toLowerCase())) text = blankFrontMatter(text);
  const chunks = chunkText(text, by).map((chunk, i) => ({
    id: `${source}#${i + 1}`,
    label: `#${i + 1}`,
    number: i + 1,
    line: chunk.line,
    text: chunk.text,
  }));
  return { source, chunks };
}

const firstString = (...values) => values.find((value) => typeof value === "string");
const firstName = (...values) => {
  const value = values.find((v) => typeof v === "string" || typeof v === "number");
  return value === undefined ? undefined : String(value);
};

/**
 * One chunk per line: {"id": "...", "text": "...", "source": "..."}. The text may also be in "page_content" or
 * "content", and the source in "metadata.source" or "metadata.file_name". Chunks are grouped by source and kept in
 * line order, so a chunk's neighbours are the lines before and after it with the same source.
 */
function loadJsonl(file) {
  const name = path.basename(file);
  const groups = new Map();
  const lines = normalize(readFileSync(file, "utf8")).split("\n");
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const where = `${name} line ${i + 1}`;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      throw new UserError(`${where} is not valid JSON.`);
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new UserError(`${where} is not a JSON object.`);
    const text = firstString(row.text, row.page_content, row.content);
    if (text === undefined) {
      throw new UserError(`${where} has no "text" string (also accepted: "page_content" or "content").`);
    }
    const source = firstName(row.source, row.metadata?.source, row.metadata?.file_name) ?? name;
    const id = firstName(row.id, row.chunk_id);
    if (!groups.has(source)) groups.set(source, []);
    const chunks = groups.get(source);
    const number = chunks.length + 1;
    // Without an id the report names the chunk #number, as for files; "line 5 line 5" would repeat itself.
    chunks.push({ id: id ?? `line ${i + 1}`, label: id ?? `#${number}`, number, line: i + 1, text: normalize(text) });
  });
  if (!groups.size) throw new UserError(`${name} has no chunks.`);
  return [...groups].map(([source, chunks]) => ({ source, chunks }));
}
