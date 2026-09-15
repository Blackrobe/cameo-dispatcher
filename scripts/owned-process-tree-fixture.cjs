const { spawn } = require("node:child_process");

const marker = process.argv[2];
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], {
  windowsHide: true,
  stdio: "ignore"
});
setInterval(() => {}, 1000);
