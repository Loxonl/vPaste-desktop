import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDevDebugOptions } from "./dev-debug-options.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
let options;
try {
  options = parseDevDebugOptions(process.argv.slice(2), os.platform(), process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

console.info(`[DEV] Main interface: ${options.mainUi}. App arguments: ${options.appArgs.join(" ")}`);

function run(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("error", error => {
    console.error(`Failed to start developer mode: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (os.platform() === "win32") {
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(scriptDir, "run-dev-app.ps1"),
    "-DeveloperMode",
    "-MainUi",
    options.mainUi,
  ]);
} else if (os.platform() === "darwin") {
  const runningApp = spawnSync("pgrep", ["-x", "vPaste"], { encoding: "utf8" });
  if (runningApp.status === 0) {
    console.error(`Quit the running vPaste app before starting developer mode. Requested main interface: ${options.mainUi}.`);
    process.exit(1);
  }

  run(path.join(root, "node_modules", ".bin", "tauri"), [
    "dev",
    "--",
    "--",
    ...options.appArgs,
  ]);
} else {
  console.error("Developer mode currently supports Windows and macOS only.");
  process.exit(1);
}
