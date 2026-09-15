import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function collectMatches(directory, sessionId, matches) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory())
      await collectMatches(candidate, sessionId, matches);
    else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`))
      matches.push(candidate);
  }
}

async function readSessionMetadata(filePath) {
  const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim())
        continue;
      const record = JSON.parse(line);
      if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object")
        throw new Error("the active session file has no valid session_meta header");
      return record.payload;
    }
  } finally {
    lines.close();
  }
  throw new Error("the active session file is empty");
}

export async function findActiveSessionFile(
  sessionId,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  expectedCwd = null
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
    throw new Error("sessionId must be a UUID");
  const sessionsRoot = path.join(path.resolve(codexHome), "sessions");
  const matches = [];
  await collectMatches(sessionsRoot, sessionId, matches);
  if (matches.length === 0)
    return null;
  if (matches.length !== 1)
    throw new Error("the dispatcher session UUID matched more than one active session file");
  if (!isWithin(sessionsRoot, matches[0]))
    throw new Error("the dispatcher session file resolved outside the active session store");
  const metadata = await readSessionMetadata(matches[0]);
  for (const recordedId of [metadata.id, metadata.session_id].filter(Boolean)) {
    if (recordedId !== sessionId)
      throw new Error("the active session metadata UUID does not match the dispatcher-owned session");
  }
  if (!metadata.id && !metadata.session_id)
    throw new Error("the active session metadata does not contain a session UUID");
  if (expectedCwd && (typeof metadata.cwd !== "string" || path.resolve(metadata.cwd) !== path.resolve(expectedCwd)))
    throw new Error("the active session metadata cwd does not match the dispatcher-owned worktree");
  return path.resolve(matches[0]);
}
