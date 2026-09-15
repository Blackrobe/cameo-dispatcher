import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

function tokenMatches(received, expected) {
  if (typeof received !== "string" || !received.startsWith("Bearer "))
    return false;
  const actual = createHash("sha256").update(received.slice(7)).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actual, wanted);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024)
      throw new Error("request body exceeds 128 KiB");
    chunks.push(chunk);
  }
  if (chunks.length === 0)
    return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createApiServer({ config, store, onCompletionReady }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/healthz")
        return sendJson(response, 200, { status: "ok" });

      if (!tokenMatches(request.headers.authorization, config.runnerToken))
        return sendJson(response, 401, { error: "unauthorized" });

      if (request.method === "GET" && url.pathname === "/v1/control")
        return sendJson(response, 200, {
          control: store.getControlState(),
          runner: store.getRunnerStatus(config.runnerId)
        });

      if (request.method === "POST" && url.pathname === "/v1/worker/claim") {
        await readJson(request);
        const job = store.claimGithubAction(config.runnerId, config.jobLeaseSeconds)
          ?? store.claim(config.runnerId, config.jobLeaseSeconds);
        const busy = job?.state === "running";
        const runner = store.recordRunnerPresence(config.runnerId, busy ? "busy" : "idle", busy ? job.id : null);
        return sendJson(response, 200, { job, control: store.getControlState(), runner });
      }

      const githubResultMatch = url.pathname.match(/^\/v1\/github-actions\/([^/]+)\/result$/);
      if (request.method === "POST" && githubResultMatch) {
        const body = await readJson(request);
        const completed = store.completeGithubAction(
          decodeURIComponent(githubResultMatch[1]), config.runnerId,
          String(body.state ?? ""), body.result ?? null,
          body.error === undefined ? null : String(body.error)
        );
        if (!completed)
          return sendJson(response, 404, { error: "GitHub action not found" });
        store.recordRunnerPresence(config.runnerId, "idle");
        onCompletionReady();
        return sendJson(response, 200, { job: completed });
      }

      const heartbeatMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/heartbeat$/);
      if (request.method === "POST" && heartbeatMatch) {
        await readJson(request);
        const job = store.heartbeat(decodeURIComponent(heartbeatMatch[1]), config.runnerId, config.jobLeaseSeconds);
        const runner = store.recordRunnerPresence(config.runnerId, "busy", job.id);
        return sendJson(response, 200, { job, runner });
      }

      const resultMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/result$/);
      if (request.method === "POST" && resultMatch) {
        const body = await readJson(request);
        const completed = store.complete(
          decodeURIComponent(resultMatch[1]),
          config.runnerId,
          String(body.state ?? ""),
          body.result ?? null,
          body.error === undefined ? null : String(body.error)
        );
        if (!completed)
          return sendJson(response, 404, { error: "job not found" });
        store.recordRunnerPresence(config.runnerId, "idle");
        onCompletionReady();
        return sendJson(response, 200, { job: completed });
      }

      const getMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (request.method === "GET" && getMatch) {
        const job = store.get(decodeURIComponent(getMatch[1]));
        return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: "job not found" });
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });
}
