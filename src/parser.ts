import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { fail } from "./errors";
import { rejectUnsafeDisplayPath } from "./paths";
import type { BlockPatch, TargetAnchor } from "./types";

interface PatchLine {
  body: Buffer;
  eol: Buffer;
}

interface Hunk {
  kind: "source" | "target";
  id: string;
  oldCount: number;
  newCount: number;
  lines: HunkLine[];
}

interface HunkLine {
  prefix: " " | "-" | "+";
  content: Buffer;
}

interface Section {
  src: string | null;
  dst: string | null;
  moveId: string;
  payloadSha256: string;
  role?: "source" | "target";
  hunks: Hunk[];
}

export const devNull = "/dev/null";
const noNewlineMarker = "\\ No newline at end of file";
const movePrefix = "blockpatch move ";
const allowedMetadataKeys = new Set(["id", "payload-sha256", "role"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const diffPrefix = Buffer.from("diff --blockpatch ", "ascii");
const hunkHeaderPrefix = Buffer.from("@@ ", "ascii");
const noNewlineMarkerBytes = Buffer.from(noNewlineMarker, "ascii");
const hunkPattern =
  /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@ blockpatch-(source|target) id=([^\s]+)(?: .*)?$/;

export function parseBlockPatch(
  input: Buffer,
  options: { stripComponents?: number } = {}
): BlockPatch {
  const lines = splitLines(input);
  const sections = parseSections(lines, normalizeStripComponents(options.stripComponents ?? 1));

  if (sections.length === 1) {
    return parseSingleSectionMove(sections[0]);
  }

  if (sections.length === 2) {
    return parseSplitSectionMove(sections);
  }

  fail("parse_error", "Patch must contain one same-file move or one split cross-file move");
}

function parseSingleSectionMove(section: Section): BlockPatch {
  if (section.src === null && section.dst === null) {
    fail("parse_error", "Patch cannot use /dev/null for both endpoints");
  }

  if (section.role !== undefined) {
    if (section.role === "source" && section.dst !== null) {
      fail("parse_error", "A source role section without a target role section must target /dev/null");
    }
    if (section.role === "target" && section.src !== null) {
      fail("parse_error", "A target role section without a source role section must source /dev/null");
    }
  }

  if (section.src !== null && section.dst !== null && !samePatchPath(section.src, section.dst)) {
    fail("parse_error", "Cross-file moves must use separate source and target file sections");
  }

  if (section.hunks.length < 1 || section.hunks.length > 2) {
    fail("parse_error", "Patch must contain one or two blockpatch hunks");
  }

  const sourceHunks = section.hunks.filter((hunk) => hunk.kind === "source");
  const targetHunks = section.hunks.filter((hunk) => hunk.kind === "target");
  if (sourceHunks.length > 1 || targetHunks.length > 1) {
    fail("parse_error", "Patch must contain at most one source hunk and at most one target hunk");
  }

  const sourceHunk = sourceHunks[0];
  const targetHunk = targetHunks[0];
  for (const hunk of section.hunks) {
    if (hunk.id !== section.moveId) {
      fail("parse_error", "Move metadata id must match source and target hunk ids");
    }
  }

  if (section.src === null) {
    if (sourceHunk !== undefined || targetHunk === undefined) {
      fail("parse_error", "A move from /dev/null must contain exactly one blockpatch-target hunk");
    }
    return buildTargetOnlyBlockPatch(section, targetHunk, { pathState: true });
  }

  if (section.dst === null) {
    if (sourceHunk === undefined || targetHunk !== undefined) {
      fail("parse_error", "A move to /dev/null must contain exactly one blockpatch-source hunk");
    }
    return buildSourceOnlyBlockPatch(section, sourceHunk, { pathState: true });
  }

  if (sourceHunk !== undefined && targetHunk !== undefined) {
    return buildPairedBlockPatch(section.src, section.dst, section.moveId, section.payloadSha256, sourceHunk, targetHunk);
  }

  if (sourceHunk !== undefined) {
    return buildSourceOnlyBlockPatch(section, sourceHunk, { pathState: false });
  }

  if (targetHunk !== undefined) {
    return buildTargetOnlyBlockPatch(section, targetHunk, { pathState: false });
  }

  fail("parse_error", "Patch must contain at least one blockpatch hunk");
}

function parseSplitSectionMove(sections: Section[]): BlockPatch {
  if (sections.some((section) => section.src === null || section.dst === null)) {
    fail("parse_error", "/dev/null endpoints are only valid in single-section moves");
  }

  if (sections.some((section) => section.role === undefined)) {
    fail("parse_error", "Split cross-file move sections must include role=source or role=target");
  }

  const sourceSections = sections.filter((section) => section.role === "source");
  const targetSections = sections.filter((section) => section.role === "target");
  if (sourceSections.length !== 1 || targetSections.length !== 1) {
    fail("parse_error", "Split cross-file moves must contain one source role section and one target role section");
  }

  const sourceSection = sourceSections[0];
  const targetSection = targetSections[0];
  const sourceFile = sourceSection.src as string;
  const targetFile = targetSection.src as string;

  if (
    !samePatchPath(sourceFile, sourceSection.dst as string) ||
    !samePatchPath(targetFile, targetSection.dst as string)
  ) {
    fail("parse_error", "Split cross-file section headers must name the same file in --- and +++");
  }

  if (samePatchPath(sourceFile, targetFile)) {
    fail("parse_error", "Split cross-file moves require different source and target files");
  }

  if (sourceSection.moveId !== targetSection.moveId) {
    fail("parse_error", "Split cross-file move sections must use the same move id");
  }

  if (sourceSection.payloadSha256 !== targetSection.payloadSha256) {
    fail("parse_error", "Split cross-file move sections must use the same payload-sha256");
  }

  if (sourceSection.hunks.length !== 1 || sourceSection.hunks[0].kind !== "source") {
    fail("parse_error", "Source role section must contain exactly one blockpatch-source hunk");
  }

  if (targetSection.hunks.length !== 1 || targetSection.hunks[0].kind !== "target") {
    fail("parse_error", "Target role section must contain exactly one blockpatch-target hunk");
  }

  const sourceHunk = sourceSection.hunks[0];
  const targetHunk = targetSection.hunks[0];
  if (sourceHunk.id !== sourceSection.moveId || targetHunk.id !== targetSection.moveId) {
    fail("parse_error", "Move metadata id must match source and target hunk ids");
  }

  return buildPairedBlockPatch(
    sourceFile,
    targetFile,
    sourceSection.moveId,
    sourceSection.payloadSha256,
    sourceHunk,
    targetHunk
  );
}

function buildPairedBlockPatch(
  src: string,
  dst: string,
  moveId: string,
  payloadSha256: string,
  sourceHunk: Hunk,
  targetHunk: Hunk
): BlockPatch {
  const source = parseSourceHunk(sourceHunk);
  const target = parseTargetHunk(targetHunk);
  const targetPayload = payloadBytes(targetHunk, "+");

  if (!source.payload.equals(targetPayload)) {
    fail("payload_mismatch", "Target added payload does not match source removed payload", {
      phase: "payload",
      anchor: "blockpatch-target"
    });
  }

  verifyPayloadHash(source.payload, payloadSha256);

  return {
    type: "move",
    id: moveId,
    src,
    dst,
    payloadSha256,
    hasSourceHunk: true,
    sourceBefore: source.before,
    sourcePayload: source.payload,
    sourceAfter: source.after,
    target
  };
}

function buildSourceOnlyBlockPatch(
  section: Section,
  sourceHunk: Hunk,
  options: { pathState: boolean }
): BlockPatch {
  const source = parseSourceHunk(sourceHunk, { allowEmptyPayload: options.pathState });
  if (options.pathState && (source.before.length !== 0 || source.after.length !== 0)) {
    fail("parse_error", "A move to /dev/null must describe whole-file payload without context");
  }
  verifyPayloadHash(source.payload, section.payloadSha256);
  return {
    type: "move",
    id: section.moveId,
    src: section.src,
    dst: section.dst,
    payloadSha256: section.payloadSha256,
    hasSourceHunk: true,
    sourceBefore: source.before,
    sourcePayload: source.payload,
    sourceAfter: source.after,
    target: null
  };
}

function buildTargetOnlyBlockPatch(
  section: Section,
  targetHunk: Hunk,
  options: { pathState: boolean }
): BlockPatch {
  const target = parseTargetHunk(targetHunk, {
    allowEmptyAnchors: options.pathState,
    allowEmptyPayload: options.pathState
  });
  if (options.pathState && (target.before.length !== 0 || target.after.length !== 0)) {
    fail("parse_error", "A move from /dev/null must describe whole-file payload without context");
  }
  const payload = payloadBytes(targetHunk, "+");
  verifyPayloadHash(payload, section.payloadSha256);
  return {
    type: "move",
    id: section.moveId,
    src: section.src,
    dst: section.dst,
    payloadSha256: section.payloadSha256,
    hasSourceHunk: false,
    sourceBefore: Buffer.alloc(0),
    sourcePayload: payload,
    sourceAfter: Buffer.alloc(0),
    target
  };
}

function verifyPayloadHash(payload: Buffer, payloadSha256: string): void {
  const actualHash = createHash("sha256").update(payload).digest("hex");
  if (actualHash !== payloadSha256) {
    fail("hash_mismatch", "payload-sha256 does not match moved payload", {
      phase: "payload",
      anchor: "payload-sha256"
    });
  }
}

function parseSections(lines: PatchLine[], stripComponents: number): Section[] {
  if (text(lines[0])?.startsWith("diff --blockpatch ") !== true) {
    fail("parse_error", "Patch must start with diff --blockpatch");
  }

  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lineStartsWith(lines[index], diffPrefix)) {
      starts.push(index);
    }
  }

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    return parseSection(lines, start, end, stripComponents);
  });
}

function parseSection(
  lines: PatchLine[],
  start: number,
  end: number,
  stripComponents: number
): Section {
  if (text(lines[start + 1]) !== "blockpatch version 1") {
    fail("parse_error", "Patch must declare blockpatch version 1");
  }

  const moveLine = text(lines[start + 2]);
  if (moveLine?.startsWith(movePrefix) !== true) {
    fail("parse_error", "Patch must declare blockpatch move metadata");
  }

  const metadata = parseMetadata(moveLine.slice(movePrefix.length));
  const moveId = metadata.get("id");
  const payloadSha256 = metadata.get("payload-sha256");
  const role = metadata.get("role");
  if (!moveId) {
    fail("parse_error", "blockpatch move metadata must include id=<id>");
  }
  if (!payloadSha256 || !/^[a-f0-9]{64}$/.test(payloadSha256)) {
    fail("parse_error", "blockpatch move metadata must include payload-sha256=<64 hex chars>");
  }
  if (role !== undefined && role !== "source" && role !== "target") {
    fail("parse_error", "blockpatch move role must be source or target");
  }

  const oldRawPath = parseFileHeader(text(lines[start + 3]), "---", "a/");
  const newRawPath = parseFileHeader(text(lines[start + 4]), "+++", "b/");

  if (text(lines[start])?.trimEnd() !== `diff --blockpatch ${oldRawPath} ${newRawPath}`) {
    fail("parse_error", "diff --blockpatch paths must match the --- and +++ headers");
  }
  validatePatchDeclaredPath(oldRawPath, "--- file header path");
  validatePatchDeclaredPath(newRawPath, "+++ file header path");

  let hunkStart = start + 5;
  while (hunkStart < end && text(lines[hunkStart]) === "") {
    hunkStart += 1;
  }

  return {
    src: oldRawPath === devNull ? null : stripPath(oldRawPath, stripComponents),
    dst: newRawPath === devNull ? null : stripPath(newRawPath, stripComponents),
    moveId,
    payloadSha256,
    role,
    hunks: parseHunks(lines, hunkStart, end)
  };
}

function normalizeStripComponents(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    fail("parse_error", "stripComponents must be a non-negative integer");
  }
  return value;
}

function parseHunks(lines: PatchLine[], start: number, end: number): Hunk[] {
  const hunks: Hunk[] = [];
  let index = start;

  while (index < end) {
    const header = text(lines[index]);
    if (header === "") {
      index += 1;
      continue;
    }

    const parsedHeader = parseHunkHeader(header);
    if (parsedHeader === undefined) {
      fail("parse_error", "Expected blockpatch source/target hunk header");
    }

    const hunk: Hunk = {
      kind: parsedHeader.kind,
      id: parsedHeader.id,
      oldCount: parsedHeader.oldCount,
      newCount: parsedHeader.newCount,
      lines: []
    };
    index += 1;

    while (index < end) {
      const body = lines[index].body;
      if (isHunkHeaderLine(lines[index])) {
        break;
      }

      if (body.length === 0) {
        let lookahead = index + 1;
        while (lookahead < end && lines[lookahead].body.length === 0) {
          lookahead += 1;
        }
        if (lookahead < end && !isHunkHeaderLine(lines[lookahead])) {
          fail(
            "parse_error",
            "Hunk bodies must not contain blank lines; encode an empty context line as a single space"
          );
        }
        break;
      }

      const first = body[0];
      if (first !== 0x20 && first !== 0x2d && first !== 0x2b) {
        fail("parse_error", "Hunk body lines must start with space, -, or +");
      }

      let content = Buffer.concat([body.subarray(1), lines[index].eol]);
      if (index + 1 < lines.length && lineEquals(lines[index + 1], noNewlineMarkerBytes)) {
        const bareCr = lines[index].eol[0] === 0x0d ? lines[index].eol.subarray(0, 1) : Buffer.alloc(0);
        content = Buffer.concat([body.subarray(1), bareCr]);
        index += 1;
      }

      hunk.lines.push({
        prefix: String.fromCharCode(first) as " " | "-" | "+",
        content
      });
      index += 1;
    }

    validateHunkCounts(hunk);
    hunks.push(hunk);
  }

  return hunks;
}

function samePatchPath(left: string, right: string): boolean {
  return posix.normalize(left) === posix.normalize(right);
}

function isHunkHeaderLine(line: PatchLine | undefined): boolean {
  return lineStartsWith(line, hunkHeaderPrefix) && parseHunkHeader(text(line)) !== undefined;
}

function parseHunkHeader(
  header: string | undefined
): { kind: "source" | "target"; id: string; oldCount: number; newCount: number } | undefined {
  const match = header?.match(hunkPattern);
  if (match === undefined || match === null) {
    return undefined;
  }

  return {
    oldCount: match[1] === undefined ? 1 : Number(match[1]),
    newCount: match[2] === undefined ? 1 : Number(match[2]),
    kind: match[3] === "source" ? "source" : "target",
    id: match[4]
  };
}

function validateHunkCounts(hunk: Hunk): void {
  const oldCount = hunk.lines.filter((line) => line.prefix === " " || line.prefix === "-").length;
  const newCount = hunk.lines.filter((line) => line.prefix === " " || line.prefix === "+").length;

  if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
    fail(
      "parse_error",
      `Hunk line counts do not match header for blockpatch-${hunk.kind} id=${hunk.id}`
    );
  }
}

function parseSourceHunk(
  hunk: Hunk,
  options: { allowEmptyPayload?: boolean } = {}
): { before: Buffer; payload: Buffer; after: Buffer } {
  const removedIndexes = hunk.lines
    .map((line, index) => (line.prefix === "-" ? index : -1))
    .filter((index) => index !== -1);

  if (removedIndexes.length === 0) {
    if (options.allowEmptyPayload === true && hunk.lines.length === 0) {
      return { before: Buffer.alloc(0), payload: Buffer.alloc(0), after: Buffer.alloc(0) };
    }
    fail("parse_error", "Source hunk must contain removed payload lines");
  }

  assertContiguous(removedIndexes, "Source payload lines must be contiguous");

  const firstRemoved = removedIndexes[0];
  const lastRemoved = removedIndexes[removedIndexes.length - 1];
  const beforeLines = hunk.lines.slice(0, firstRemoved);
  const afterLines = hunk.lines.slice(lastRemoved + 1);

  if (!beforeLines.every((line) => line.prefix === " ") || !afterLines.every((line) => line.prefix === " ")) {
    fail("parse_error", "Source hunk may only contain context lines around removed payload");
  }

  const before = concatLines(beforeLines);
  const payload = payloadBytes(hunk, "-");
  const after = concatLines(afterLines);

  return { before, payload, after };
}

function parseTargetHunk(
  hunk: Hunk,
  options: { allowEmptyAnchors?: boolean; allowEmptyPayload?: boolean } = {}
): TargetAnchor {
  const addedIndexes = hunk.lines
    .map((line, index) => (line.prefix === "+" ? index : -1))
    .filter((index) => index !== -1);

  if (addedIndexes.length === 0) {
    if (options.allowEmptyPayload === true && hunk.lines.length === 0) {
      return { before: Buffer.alloc(0), after: Buffer.alloc(0) };
    }
    fail("parse_error", "Target hunk must contain added payload lines");
  }

  assertContiguous(addedIndexes, "Target payload lines must be contiguous");

  const firstAdded = addedIndexes[0];
  const lastAdded = addedIndexes[addedIndexes.length - 1];
  const beforeLines = hunk.lines.slice(0, firstAdded);
  const afterLines = hunk.lines.slice(lastAdded + 1);

  if (!beforeLines.every((line) => line.prefix === " ") || !afterLines.every((line) => line.prefix === " ")) {
    fail("parse_error", "Target hunk may only contain context lines around added payload");
  }

  const before = concatLines(beforeLines);
  const after = concatLines(afterLines);

  if (before.length === 0 && after.length === 0 && options.allowEmptyAnchors !== true) {
    fail("parse_error", "Target hunk must include context before or after the moved payload");
  }

  return { before, after };
}

function payloadBytes(hunk: Hunk, prefix: "-" | "+"): Buffer {
  return concatLines(hunk.lines.filter((line) => line.prefix === prefix));
}

function concatLines(lines: Pick<HunkLine, "content">[]): Buffer {
  return Buffer.concat(lines.map((line) => line.content));
}

function assertContiguous(indexes: number[], message: string): void {
  for (let index = 1; index < indexes.length; index += 1) {
    if (indexes[index] !== indexes[index - 1] + 1) {
      fail("parse_error", message);
    }
  }
}

function parseMetadata(input: string): Map<string, string> {
  const metadata = new Map<string, string>();
  for (const part of input.trim().split(/\s+/)) {
    const equals = part.indexOf("=");
    if (equals <= 0) {
      fail("parse_error", `Invalid blockpatch move metadata field: ${part}`);
    }
    const key = part.slice(0, equals);
    if (metadata.has(key)) {
      fail("parse_error", `Duplicate blockpatch move metadata field: ${key}`);
    }
    if (!allowedMetadataKeys.has(key) && !key.startsWith("x-")) {
      fail("parse_error", `Unknown blockpatch move metadata field: ${key}`);
    }
    metadata.set(key, part.slice(equals + 1));
  }
  return metadata;
}

function parseFileHeader(
  line: string | undefined,
  prefix: "---" | "+++",
  requiredPathPrefix: "a/" | "b/"
): string {
  const marker = `${prefix} `;
  const rawPath = line?.startsWith(marker) === true ? line.slice(marker.length) : undefined;
  if (rawPath !== undefined) {
    rejectUnsafeDisplayPath(rawPath, `${prefix} file header path`);
  }
  if (rawPath?.trim() === devNull && line?.startsWith(marker)) {
    return devNull;
  }
  if (line?.startsWith(`${marker}${requiredPathPrefix}`) !== true) {
    fail("parse_error", `Patch must include a ${marker}${requiredPathPrefix}<path> or ${marker}${devNull} header`);
  }

  const path = rawPath?.trim() ?? "";
  if (!path || path === requiredPathPrefix) {
    fail("parse_error", `${prefix} file header must include a path`);
  }

  return path;
}

function stripPath(path: string, stripComponents: number): string {
  const stripped = path.split("/").slice(stripComponents).join("/");
  if (!stripped) {
    fail("parse_error", `-p${stripComponents} removes the entire path: ${path}`);
  }
  return stripped;
}

function validatePatchDeclaredPath(path: string, label: string): void {
  if (path === devNull) {
    return;
  }
  if (path.includes("\\")) {
    fail("invalid_path", `${label} must use POSIX-style / separators: ${path}`, {
      path,
      phase: "path"
    });
  }
  if (path.split("/").some((part) => part === "." || part === "..")) {
    fail("invalid_path", `${label} must not contain . or .. path segments: ${path}`, {
      path,
      phase: "path"
    });
  }
  if (path.split("/").some((part) => part === "")) {
    fail("invalid_path", `${label} must not contain empty path segments: ${path}`, {
      path,
      phase: "path"
    });
  }
}

function splitLines(input: Buffer): PatchLine[] {
  const lines: PatchLine[] = [];
  let position = 0;

  while (position < input.length) {
    const lf = input.indexOf(0x0a, position);
    const lineEnd = lf === -1 ? input.length : lf;
    const hasCr = lf !== -1 && lineEnd > position && input[lineEnd - 1] === 0x0d;
    const bodyEnd = hasCr ? lineEnd - 1 : lineEnd;
    const eol =
      lf === -1
        ? Buffer.alloc(0)
        : input.subarray(hasCr ? lineEnd - 1 : lineEnd, lf + 1);

    lines.push({
      body: Buffer.from(input.subarray(position, bodyEnd)),
      eol: Buffer.from(eol)
    });

    if (lf === -1) {
      break;
    }
    position = lf + 1;
  }

  return lines;
}

function text(line: PatchLine | undefined): string | undefined {
  if (line === undefined) {
    return undefined;
  }
  try {
    return utf8Decoder.decode(line.body);
  } catch {
    fail("invalid_utf8", "Patch control line is not valid UTF-8", {
      phase: "parse"
    });
  }
}

function lineStartsWith(line: PatchLine | undefined, prefix: Buffer): boolean {
  return line?.body.subarray(0, prefix.length).equals(prefix) === true;
}

function lineEquals(line: PatchLine | undefined, expected: Buffer): boolean {
  return line?.body.equals(expected) === true;
}
