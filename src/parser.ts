import { createHash } from "node:crypto";
import { posix } from "node:path";
import { fail } from "./errors";
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
  src: string;
  dst: string;
  moveId: string;
  payloadSha256: string;
  role?: "source" | "target";
  hunks: Hunk[];
}

const noNewlineMarker = "\\ No newline at end of file";
const movePrefix = "blockpatch move ";
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
  if (section.role !== undefined) {
    fail("parse_error", "role metadata is only valid for split cross-file move sections");
  }

  if (!samePatchPath(section.src, section.dst)) {
    fail("parse_error", "Cross-file moves must use separate source and target file sections");
  }

  if (section.hunks.length !== 2) {
    fail("parse_error", "Patch must contain exactly one source hunk and one target hunk");
  }

  const sourceHunk = section.hunks.find((hunk) => hunk.kind === "source");
  const targetHunk = section.hunks.find((hunk) => hunk.kind === "target");
  if (sourceHunk === undefined || targetHunk === undefined) {
    fail("parse_error", "Patch must contain paired blockpatch-source and blockpatch-target hunks");
  }

  if (sourceHunk.id !== section.moveId || targetHunk.id !== section.moveId) {
    fail("parse_error", "Move metadata id must match source and target hunk ids");
  }

  return buildBlockPatch(section.src, section.dst, section.moveId, section.payloadSha256, sourceHunk, targetHunk);
}

function parseSplitSectionMove(sections: Section[]): BlockPatch {
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

  if (!samePatchPath(sourceSection.src, sourceSection.dst) || !samePatchPath(targetSection.src, targetSection.dst)) {
    fail("parse_error", "Split cross-file section headers must name the same file in --- and +++");
  }

  if (samePatchPath(sourceSection.src, targetSection.src)) {
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

  return buildBlockPatch(
    sourceSection.src,
    targetSection.src,
    sourceSection.moveId,
    sourceSection.payloadSha256,
    sourceHunk,
    targetHunk
  );
}

function buildBlockPatch(
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

  const actualHash = createHash("sha256").update(source.payload).digest("hex");
  if (actualHash !== payloadSha256) {
    fail("hash_mismatch", "payload-sha256 does not match moved payload", {
      phase: "payload",
      anchor: "payload-sha256"
    });
  }

  return {
    type: "move",
    id: moveId,
    src,
    dst,
    payloadSha256,
    sourceBefore: source.before,
    sourcePayload: source.payload,
    sourceAfter: source.after,
    target
  };
}

function parseSections(lines: PatchLine[], stripComponents: number): Section[] {
  if (text(lines[0])?.startsWith("diff --blockpatch ") !== true) {
    fail("parse_error", "Patch must start with diff --blockpatch");
  }

  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (text(lines[index])?.startsWith("diff --blockpatch ") === true) {
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

  let hunkStart = start + 5;
  while (hunkStart < end && text(lines[hunkStart]) === "") {
    hunkStart += 1;
  }

  return {
    src: stripPath(oldRawPath, stripComponents),
    dst: stripPath(newRawPath, stripComponents),
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
      const maybeHeader = text(lines[index]);
      if (parseHunkHeader(maybeHeader) !== undefined) {
        break;
      }

      const body = lines[index].body;
      if (body.length === 0) {
        let lookahead = index + 1;
        while (lookahead < end && lines[lookahead].body.length === 0) {
          lookahead += 1;
        }
        if (lookahead < end && parseHunkHeader(text(lines[lookahead])) === undefined) {
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
      if (index + 1 < lines.length && text(lines[index + 1]) === noNewlineMarker) {
        content = Buffer.from(body.subarray(1));
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

function parseSourceHunk(hunk: Hunk): { before: Buffer; payload: Buffer; after: Buffer } {
  const removedIndexes = hunk.lines
    .map((line, index) => (line.prefix === "-" ? index : -1))
    .filter((index) => index !== -1);

  if (removedIndexes.length === 0) {
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

function parseTargetHunk(hunk: Hunk): TargetAnchor {
  const addedIndexes = hunk.lines
    .map((line, index) => (line.prefix === "+" ? index : -1))
    .filter((index) => index !== -1);

  if (addedIndexes.length === 0) {
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

  if (before.length === 0 && after.length === 0) {
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
  for (const part of input.split(/\s+/)) {
    const equals = part.indexOf("=");
    if (equals === -1) {
      fail("parse_error", `Invalid blockpatch move metadata field: ${part}`);
    }
    metadata.set(part.slice(0, equals), part.slice(equals + 1));
  }
  return metadata;
}

function parseFileHeader(
  line: string | undefined,
  prefix: "---" | "+++",
  requiredPathPrefix: "a/" | "b/"
): string {
  const marker = `${prefix} `;
  if (line?.startsWith(`${marker}${requiredPathPrefix}`) !== true) {
    fail("parse_error", `Patch must include a ${marker}${requiredPathPrefix}<path> header`);
  }

  const path = line.slice(marker.length).trim();
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

function splitLines(input: Buffer): PatchLine[] {
  const lines: PatchLine[] = [];
  let position = 0;

  while (position < input.length) {
    const lf = input.indexOf(0x0a, position);
    const lineEnd = lf === -1 ? input.length : lf;
    const hasCr = lineEnd > position && input[lineEnd - 1] === 0x0d;
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
  return line?.body.toString("utf8");
}
