import { spawnSync } from "node:child_process";

export function terminateProcessTree(child, platform = process.platform) {
  if (!child?.pid)
    return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    return;
  }
  child.kill("SIGTERM");
}

export async function waitForChildWithTimeout(child, timeoutMs, terminate = terminateProcessTree) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("timeoutMs must be a positive integer");

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, timeoutMs);
  timeout.unref();

  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { exitCode, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}
