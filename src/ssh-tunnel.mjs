import net from "node:net";
import { spawn } from "node:child_process";

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function portAcceptsConnections(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function createSshTunnel({ sshBin, destination, localPort = 18765, remoteHost = "127.0.0.1", remotePort = 8765 }, dependencies = {}) {
  if (!sshBin || !destination || !Number.isInteger(localPort) || !Number.isInteger(remotePort))
    throw new Error("SSH tunnel configuration is invalid");
  let child = null;
  const spawnProcess = dependencies.spawn ?? spawn;
  const checkPort = dependencies.portAcceptsConnections ?? portAcceptsConnections;
  const wait = dependencies.delay ?? delay;
  const isProcessAlive = dependencies.processExists ?? processExists;

  return {
    get active() { return child !== null && child.exitCode === null; },
    async start() {
      if (this.active)
        return;
      if (await checkPort(localPort))
        throw new Error(`local tunnel port ${localPort} is already in use`);
      child = spawnProcess(sshBin, [
        "-N", "-T", "-L", `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
        "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", destination
      ], { shell: false, windowsHide: true, stdio: "ignore" });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (child.exitCode !== null)
          throw new Error(`SSH tunnel exited before becoming ready (${child.exitCode})`);
        if (await checkPort(localPort))
          return;
        await wait(250);
      }
      await this.stop();
      throw new Error("SSH tunnel did not become ready within five seconds");
    },
    async stop() {
      const current = child;
      if (!current || current.exitCode !== null)
      {
        child = null;
        return;
      }
      current.kill();
      for (let attempt = 0; attempt < 25; attempt += 1) {
        if (!isProcessAlive(current.pid) && !await checkPort(localPort)) {
          child = null;
          return;
        }
        await wait(100);
      }
      if (current.exitCode === null)
        current.kill("SIGKILL");
      for (let attempt = 0; attempt < 25; attempt += 1) {
        if (!isProcessAlive(current.pid) && !await checkPort(localPort)) {
          child = null;
          return;
        }
        await wait(100);
      }
      throw new Error("SSH tunnel shutdown could not be confirmed; refusing to start a model");
    }
  };
}
