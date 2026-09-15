import path from "node:path";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { atomicWriteJson, readJson, validateJob } from "./lib.mjs";
import { buildCompletion, normalizeServerJob, sanitizeWorkerEnvironment } from "./worker-service-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const once = process.argv.includes("--once");
const dispatcherUrl = process.env.CAMEO_DISPATCHER_URL?.replace(/\/$/, "");
const runnerToken = process.env.CAMEO_RUNNER_TOKEN;
const runnerId = process.env.CAMEO_RUNNER_ID?.trim() || "blackrobe-windows-1";
const pollIntervalMs = Number(process.env.CAMEO_POLL_INTERVAL_MS ?? 5000);
const maxConsecutiveErrors = Number(process.env.CAMEO_MAX_CONSECUTIVE_ERRORS ?? 6);
const localConfigPath = path.resolve(process.env.CAMEO_RUNNER_CONFIG ?? path.join(projectRoot, "config.json"));

if (!dispatcherUrl)
  throw new Error("CAMEO_DISPATCHER_URL is required");
if (!runnerToken)
  throw new Error("CAMEO_RUNNER_TOKEN is required");
if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000)
  throw new Error("CAMEO_POLL_INTERVAL_MS must be an integer of at least 1000");
if (!Number.isInteger(maxConsecutiveErrors) || maxConsecutiveErrors < 1)
  throw new Error("CAMEO_MAX_CONSECUTIVE_ERRORS must be a positive integer");

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function api(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  timeout.unref();
  try {
    const response = await fetch(`${dispatcherUrl}${pathname}`, {
      ...options,
      headers: {
        authorization: `Bearer ${runnerToken}`,
        "content-type": "application/json",
        ...(options.headers ?? {})
      },
      signal: controller.signal
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(`dispatcher ${response.status}: ${body.error ?? "request failed"}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function postCompletion(job, status, finalResult) {
  const completion = buildCompletion(status, finalResult);
  await api(`/v1/jobs/${encodeURIComponent(job.id)}/result`, {
    method: "POST",
    body: JSON.stringify(completion)
  });
}

async function runLocalJob(job) {
  const normalized = validateJob(normalizeServerJob(job));
  const localConfig = await readJson(localConfigPath);
  const incomingPath = path.join(localConfig.stateRoot, "incoming", `${normalized.requestId}.json`);
  await atomicWriteJson(incomingPath, normalized);

  const statusPath = path.join(localConfig.stateRoot, "jobs", normalized.requestId, "status.json");
  const runnerScript = path.join(scriptDirectory, "run-job.mjs");
  const child = spawn(process.execPath, [runnerScript, localConfigPath, incomingPath], {
    cwd: projectRoot,
    env: sanitizeWorkerEnvironment(process.env),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"]
  });

  const heartbeat = setInterval(() => {
    api(`/v1/jobs/${encodeURIComponent(job.id)}/heartbeat`, { method: "POST", body: "{}" })
      .catch(error => console.error(`heartbeat failed for ${job.id}: ${error.message}`));
  }, 15000);
  heartbeat.unref();

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearInterval(heartbeat);

  const status = await readJson(statusPath);
  let finalResult = null;
  if (status.finalPath)
    finalResult = JSON.parse(await readFile(status.finalPath, "utf8"));
  if (exitCode !== 0)
    console.error(`local worker ${job.id} exited ${exitCode} with retained state ${status.state}`);
  await postCompletion(job, status, finalResult);
}

async function reconcileExisting(job) {
  const localConfig = await readJson(localConfigPath);
  const statusPath = path.join(localConfig.stateRoot, "jobs", job.requestId, "status.json");
  try {
    const status = await readJson(statusPath);
    if (["ready_for_review", "needs_attention", "failed"].includes(status.state)) {
      let finalResult = null;
      if (status.finalPath)
        finalResult = JSON.parse(await readFile(status.finalPath, "utf8"));
      await postCompletion(job, status, finalResult);
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
  }

  console.error(`job ${job.id} has an existing running claim; waiting for lease reconciliation`);
}

async function pollOnce() {
  const { job } = await api("/v1/worker/claim", { method: "POST", body: "{}" });
  if (!job)
    return false;

  if (job.claimDisposition === "expired_needs_attention") {
    await reconcileExisting(job);
    return true;
  }

  if (job.claimDisposition === "existing_running") {
    await reconcileExisting(job);
    return true;
  }

  await runLocalJob(job);
  return true;
}

let consecutiveErrors = 0;
do {
  try {
    await pollOnce();
    consecutiveErrors = 0;
  } catch (error) {
    console.error(error.message);
    consecutiveErrors += 1;
    if (once || consecutiveErrors >= maxConsecutiveErrors) {
      process.exitCode = 1;
      break;
    }
  }
  if (!once)
    await delay(pollIntervalMs);
} while (!once);
