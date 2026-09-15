import test from "node:test";
import assert from "node:assert/strict";

import { createSshTunnel } from "../src/ssh-tunnel.mjs";

test("tunnel stop fails closed when process and loopback port remain active", async () => {
  const child = { pid: 424242, exitCode: null, kill() {} };
  const tunnel = createSshTunnel({
    sshBin: "C:\\trusted\\ssh.exe", destination: "host", localPort: 18765
  }, {
    spawn: () => child,
    portAcceptsConnections: async () => {
      if (!tunnel.active)
        return false;
      return true;
    },
    processExists: () => true,
    delay: async () => {}
  });
  await tunnel.start();
  await assert.rejects(() => tunnel.stop(), /shutdown could not be confirmed/);
  assert.equal(tunnel.active, true);
  await assert.rejects(() => tunnel.stop(), /shutdown could not be confirmed/);
});
