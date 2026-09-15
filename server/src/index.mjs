import { loadConfig } from "./config.mjs";
import { JobStore } from "./db.mjs";
import { startDiscord } from "./discord.mjs";
import { createApiServer } from "./http.mjs";

const config = loadConfig();
const store = new JobStore(config.databasePath);
const discord = await startDiscord(config, store);
let deliveryRunning = false;
let stopping = false;

async function deliverPending() {
  if (deliveryRunning || stopping)
    return;
  deliveryRunning = true;
  try {
    for (const job of store.listPendingDeliveries()) {
      try {
        const messageId = await discord.publishJob(job);
        store.markDelivered(job.id, job.deliveryRevision, messageId);
      } catch (error) {
        store.markDeliveryFailed(job.id, job.deliveryRevision, error.message, error.retryAfterMs);
      }
    }
  } finally {
    deliveryRunning = false;
  }
}

const server = createApiServer({
  config,
  store,
  onCompletionReady: () => setImmediate(deliverPending)
});

server.listen(config.listenPort, config.listenHost, () => {
  console.log(`Cameo Dispatcher listening on ${config.listenHost}:${config.listenPort}`);
});
const deliveryTimer = setInterval(deliverPending, 10000);
deliveryTimer.unref();

async function shutdown(signal) {
  if (stopping)
    return;
  stopping = true;
  console.log(`Received ${signal}; shutting down`);
  clearInterval(deliveryTimer);
  await new Promise(resolve => server.close(resolve));
  const deadline = Date.now() + 10000;
  while (deliveryRunning && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 50));
  discord.close();
  store.close();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
