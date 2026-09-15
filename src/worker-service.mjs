import path from "node:path";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { atomicWriteJson, readJson, validateFollowupJob, validateJob } from "./lib.mjs";
import { buildCompletion, normalizeServerJob, sanitizeWorkerEnvironment } from "./worker-service-lib.mjs";
import { createSshTunnel } from "./ssh-tunnel.mjs";
import { buildGithubContext } from "./github-context.mjs";
import { executeGithubAction } from "./github-action-controller.mjs";
import { reconcileGithubActionOutcomes, runLockedJournaledGithubAction } from "./github-action-journal.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const once = process.argv.includes("--once");
const dispatcherUrl = process.env.CAMEO_DISPATCHER_URL?.replace(/\/$/, "");
const runnerToken = process.env.CAMEO_RUNNER_TOKEN;
const runnerId = process.env.CAMEO_RUNNER_ID?.trim() || "blackrobe-windows-1";
const pollIntervalMs = Number(process.env.CAMEO_POLL_INTERVAL_MS ?? 5000);
const maxConsecutiveErrors = Number(process.env.CAMEO_MAX_CONSECUTIVE_ERRORS ?? 6);
const localConfigPath = path.resolve(process.env.CAMEO_RUNNER_CONFIG ?? path.join(projectRoot, "config.json"));
const sshDestination = process.env.CAMEO_SSH_DESTINATION?.trim();
const tunnelLocalPort = Number(process.env.CAMEO_TUNNEL_LOCAL_PORT ?? 18765);
const tunnelRemoteHost = process.env.CAMEO_TUNNEL_REMOTE_HOST?.trim() || "127.0.0.1";
const tunnelRemotePort = Number(process.env.CAMEO_TUNNEL_REMOTE_PORT ?? 8765);

if (!dispatcherUrl)
  throw new Error("CAMEO_DISPATCHER_URL is required");
if (!runnerToken)
  throw new Error("CAMEO_RUNNER_TOKEN is required");
if (!sshDestination)
  throw new Error("CAMEO_SSH_DESTINATION is required");
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

async function postGithubControl(action, outcome) {
  await api(`/v1/github-actions/${encodeURIComponent(action.id)}/result`, {
    method: "POST",
    body: JSON.stringify(outcome)
  });
}

function statusPathFor(localConfig, job) {
  if (job.runKind === "followup")
    return path.join(localConfig.stateRoot, "jobs", job.rootRequestId, "runs", String(job.runRevision), "status.json");
  return path.join(localConfig.stateRoot, "jobs", job.requestId, "status.json");
}

async function runLocalJob(job) {
  const serverJob = normalizeServerJob(job);
  const localConfig = await readJson(localConfigPath);
  const enrichedJob = {
    ...serverJob,
    controllerContext: buildGithubContext(localConfig, serverJob)
  };
  const normalized = enrichedJob.runKind === "followup"
    ? validateFollowupJob(enrichedJob)
    : validateJob(enrichedJob);
  const incomingPath = path.join(localConfig.stateRoot, "incoming", `${normalized.requestId}.json`);
  await atomicWriteJson(incomingPath, normalized);

  const statusPath = statusPathFor(localConfig, normalized);
  const runnerScript = path.join(scriptDirectory, normalized.runKind === "followup" ? "run-followup.mjs" : "run-job.mjs");
  const child = spawn(process.execPath, [runnerScript, localConfigPath, incomingPath], {
    cwd: projectRoot,
    env: sanitizeWorkerEnvironment(process.env),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"]
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const status = await readJson(statusPath);
  let finalResult = null;
  if (status.finalPath)
    finalResult = JSON.parse(await readFile(status.finalPath, "utf8"));
  if (exitCode !== 0)
    console.error(`local worker ${job.id} exited ${exitCode} with retained state ${status.state}`);
  return { status, finalResult };
}

async function reconcileExisting(job) {
  const localConfig = await readJson(localConfigPath);
  const statusPath = statusPathFor(localConfig, normalizeServerJob(job));
  try {
    let status = await readJson(statusPath);
    if (status.state === "needs_attention") {
      const serverJob = normalizeServerJob(job);
      const incomingPath = path.join(localConfig.stateRoot, "incoming", `${serverJob.requestId}.json`);
      const rootStateRoot = serverJob.runKind === "followup"
        ? path.join(localConfig.stateRoot, "jobs", serverJob.rootRequestId)
        : path.join(localConfig.stateRoot, "jobs", serverJob.requestId);
      try {
        const publication = await readJson(path.join(rootStateRoot, "publication.json"));
        if (["preparing", "committed", "published"].includes(publication.state)
          && publication.requestId === serverJob.requestId
          && publication.runRevision === (serverJob.runRevision ?? 1)) {
          const recoveryScript = path.join(scriptDirectory, "recover-publication.mjs");
          const recovery = spawn(process.execPath, [recoveryScript, localConfigPath, incomingPath, statusPath], {
            cwd: projectRoot, env: sanitizeWorkerEnvironment(process.env), shell: false, windowsHide: true, stdio: ["ignore", "inherit", "inherit"]
          });
          const exitCode = await new Promise((resolve, reject) => {
            recovery.once("error", reject); recovery.once("close", resolve);
          });
          if (exitCode !== 0)
            throw new Error(`publication recovery exited ${exitCode}`);
          status = await readJson(statusPath);
        }
      } catch (error) {
        if (error.code !== "ENOENT")
          throw error;
      }
    }
    if (["ready_for_review", "needs_attention", "failed"].includes(status.state)) {
      let finalResult = null;
      if (status.finalPath)
        finalResult = JSON.parse(await readFile(status.finalPath, "utf8"));
      await postCompletion(job, status, finalResult);
      return;
    }
    if (status.state === "running") {
      const serverJob = normalizeServerJob(job);
      const incomingPath = path.join(localConfig.stateRoot, "incoming", `${serverJob.requestId}.json`);
      const rootStateRoot = serverJob.runKind === "followup"
        ? path.join(localConfig.stateRoot, "jobs", serverJob.rootRequestId)
        : path.join(localConfig.stateRoot, "jobs", serverJob.requestId);
      try {
        const publication = await readJson(path.join(rootStateRoot, "publication.json"));
        if (["preparing", "committed", "published"].includes(publication.state)) {
          const recoveryScript = path.join(scriptDirectory, "recover-publication.mjs");
          const recovery = spawn(process.execPath, [recoveryScript, localConfigPath, incomingPath, statusPath], {
            cwd: projectRoot, env: sanitizeWorkerEnvironment(process.env), shell: false, windowsHide: true, stdio: ["ignore", "inherit", "inherit"]
          });
          const exitCode = await new Promise((resolve, reject) => {
            recovery.once("error", reject); recovery.once("close", resolve);
          });
          if (exitCode !== 0)
            throw new Error(`publication recovery exited ${exitCode}`);
          const recoveredStatus = await readJson(statusPath);
          const recoveredFinal = JSON.parse(await readFile(recoveredStatus.finalPath, "utf8"));
          await postCompletion(job, recoveredStatus, recoveredFinal);
          return;
        }
      } catch (error) {
        if (error.code !== "ENOENT")
          throw error;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
  }

  console.error(`job ${job.id} has an existing running claim; waiting for lease reconciliation`);
}

async function pollOnce() {
  const localConfig = await readJson(localConfigPath);
  await reconcileGithubActionOutcomes(localConfig, postGithubControl);
  const { job } = await api("/v1/worker/claim", { method: "POST", body: "{}" });
  if (!job)
    return false;

  if (job.claimDisposition === "expired_needs_attention") {
    await reconcileExisting(job);
    return true;
  }

  if (job.claimDisposition === "existing_running") {
    if (job.runKind === "github_action") {
      if (!await reconcileGithubActionOutcomes(localConfig, postGithubControl, job))
        console.error(`GitHub action ${job.id} has an existing running claim without a retained outcome; waiting for lease reconciliation`);
      return true;
    }
    await reconcileExisting(job);
    return true;
  }

  if (job.runKind === "github_action") {
    await tunnel.stop();
    let githubOutcome;
    try {
      githubOutcome = await runLockedJournaledGithubAction(localConfig, job, action => executeGithubAction(localConfig, action));
    } finally {
      await tunnel.start();
    }
    await reconcileGithubActionOutcomes(localConfig, postGithubControl, job);
    return true;
  }

  await tunnel.stop();
  let outcome;
  try {
    outcome = await runLocalJob(job);
  } finally {
    await tunnel.start();
  }
  if (outcome.status.state === "needs_attention") {
    const localConfig = await readJson(localConfigPath);
    const normalized = normalizeServerJob(job);
    const rootStateRoot = normalized.runKind === "followup"
      ? path.join(localConfig.stateRoot, "jobs", normalized.rootRequestId)
      : path.join(localConfig.stateRoot, "jobs", normalized.requestId);
    try {
      const publication = await readJson(path.join(rootStateRoot, "publication.json"));
      if (["preparing", "committed", "published"].includes(publication.state)
        && publication.requestId === normalized.requestId
        && publication.runRevision === (normalized.runRevision ?? 1)) {
        const incomingPath = path.join(localConfig.stateRoot, "incoming", `${normalized.requestId}.json`);
        const recoveryScript = path.join(scriptDirectory, "recover-publication.mjs");
        const recovery = spawn(process.execPath, [recoveryScript, localConfigPath, incomingPath, statusPathFor(localConfig, normalized)], {
          cwd: projectRoot, env: sanitizeWorkerEnvironment(process.env), shell: false, windowsHide: true, stdio: ["ignore", "inherit", "inherit"]
        });
        const recoveryExit = await new Promise((resolve, reject) => {
          recovery.once("error", reject); recovery.once("close", resolve);
        });
        if (recoveryExit !== 0)
          throw new Error(`publication recovery exited ${recoveryExit}`);
        const recoveredStatus = await readJson(statusPathFor(localConfig, normalized));
        outcome = { status: recoveredStatus, finalResult: JSON.parse(await readFile(recoveredStatus.finalPath, "utf8")) };
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
    }
  }
  await postCompletion(job, outcome.status, outcome.finalResult);
  return true;
}

const bootstrapConfig = await readJson(localConfigPath);
const tunnel = createSshTunnel({
  sshBin: bootstrapConfig.sshBin, destination: sshDestination, localPort: tunnelLocalPort,
  remoteHost: tunnelRemoteHost, remotePort: tunnelRemotePort
});
await tunnel.start();
let consecutiveErrors = 0;
try {
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
} finally {
  await tunnel.stop();
}
