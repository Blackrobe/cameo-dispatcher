import { open, readFile, unlink } from "node:fs/promises";

async function createLock(lockPath) {
  const handle = await open(lockPath, "wx");
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
  return handle;
}

export async function acquireRunnerLock(lockPath) {
  try {
    return await createLock(lockPath);
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
  }

  let ownerDescription = "unreadable owner record";
  try {
    const existing = JSON.parse(await readFile(lockPath, "utf8"));
    if (Number.isInteger(existing?.pid) && existing.pid > 0)
      ownerDescription = `recorded PID ${existing.pid}`;
  } catch {
    // Fail closed: a partially written lock may belong to a live process.
  }
  throw new Error(`dispatcher runner lock already exists (${ownerDescription}); reconcile it explicitly before starting another worker`);
}

export async function releaseRunnerLock(handle, lockPath) {
  await handle.close();
  await unlink(lockPath).catch(() => {});
}
