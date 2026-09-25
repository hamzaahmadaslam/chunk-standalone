// Splits Markdown and plain text into chunks the way common RAG chunkers do, so the check runs on chunks shaped
// like the ones your own pipeline makes: at headings, at blank lines, or every N tokens.
import { UserError } from "./errors.mjs";

export const MIN_TOKENS = 20;
export const MAX_TOKENS = 14_000;

/** A rough token count: about four characters per token, which fits English prose. Used for sizes and estimates. */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/** Parses the --by value into { mode } or { mode: "tokens", size }. */
export function parseBy(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "heading" || text === "paragraph") return { mode: text };
  const match = /^tokens=(\d+)$/.exec(text);
  if (match && Number(match[1]) >= MIN_TOKENS && Number(match[1]) <= MAX_TOKENS) {
    return { mode: "tokens", size: Number(match[1]) };
  }
  throw new UserError(
    `--by must be heading, paragraph or tokens=N with N from ${MIN_TOKENS} to ${MAX_TOKENS}, not "${value}".`,
  );
}

/** The --by value as the user would write it, for reports. */
export function describeBy(by) {
  return by.mode === "tokens" ? `tokens=${by.size}` : by.mode;
}

/** Removes a byte order mark and turns Windows and old Mac line endings into \n. */
export function normalize(text) {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** Blanks out YAML front matter at the top of a Markdown file. The lines stay, so line numbers still match the file. */
export function blankFrontMatter(text) {
  const lines = text.split("\n");
  if (!/^---\s*$/.test(lines[0])) return text;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i])) {
      for (let j = 0; j <= i; j++) lines[j] = "";
      return lines.join("\n");
    }
  }
  return text;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** Tracks fenced code blocks: returns the open fence after `line`, or null when outside a code block. */
function nextFence(line, open) {
  if (!open) {
    const match = FENCE_OPEN.exec(line);
    return match ? match[1] : null;
  }
  const match = FENCE_CLOSE.exec(line);
  return match && match[1][0] === open[0] && match[1].length >= open.length ? null : open;
}

/** Lines start..end (end excluded) as a chunk, without blank lines at either end; null when there is no text. */
function toChunk(lines, start, end) {
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  if (start === end) return null;
  return { line: start + 1, text: lines.slice(start, end).join("\n").trimEnd() };
}

/** Splits wherever `isBoundary(line)` says a new chunk starts (or, for blank lines, where one ends). */
function splitLines(lines, isBoundary, boundaryStartsChunk) {
  const chunks = [];
  let start = 0;
  let fence = null;
  lines.forEach((line, i) => {
    if (!fence && isBoundary(line)) {
      chunks.push(toChunk(lines, start, i));
      start = boundaryStartsChunk ? i : i + 1;
    }
    fence = nextFence(line, fence);
  });
  chunks.push(toChunk(lines, start, lines.length));
  return chunks.filter(Boolean);
}

/** A new chunk at every ATX heading (# to ######) outside code blocks. Text before the first heading is a chunk too. */
export function chunkByHeading(text) {
  return splitLines(normalize(text).split("\n"), (line) => HEADING.test(line), true);
}

/** A new chunk after every blank line outside code blocks. */
export function chunkByParagraph(text) {
  return splitLines(normalize(text).split("\n"), (line) => !line.trim(), false);
}

/** Chunks of at most about `size` tokens, cut between words, with no overlap. */
export function chunkByTokens(text, size) {
  const source = normalize(text);
  const maxChars = size * 4;
  const chunks = [];
  let current = "";
  let startLine = 1;
  let line = 1;
  let scanned = 0;
  const lineAt = (offset) => {
    for (; scanned < offset; scanned++) if (source.charCodeAt(scanned) === 10) line++;
    return line;
  };
  for (const match of source.matchAll(/\S+\s*/g)) {
    const word = match[0];
    if (current && current.length + word.trimEnd().length > maxChars) {
      chunks.push({ line: startLine, text: current.trimEnd() });
      current = "";
    }
    if (!current) startLine = lineAt(match.index);
    current += word;
  }
  if (current.trim()) chunks.push({ line: startLine, text: current.trimEnd() });
  return chunks;
}

/** Splits `text` with the parsed --by value. Returns [{ line, text }] with 1-based line numbers. */
export function chunkText(text, by) {
  if (by.mode === "heading") return chunkByHeading(text);
  if (by.mode === "paragraph") return chunkByParagraph(text);
  return chunkByTokens(text, by.size);
}
