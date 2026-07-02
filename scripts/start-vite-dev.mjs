import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const port = "1420";

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: root, windowsHide: true }, () => resolve());
  });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function stopStaleVite() {
  if (os.platform() === "win32") {
    const ps = `
$Root = ${JSON.stringify(root)}
$EscapedRoot = [Regex]::Escape($Root)
$Listeners = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue
foreach ($Listener in $Listeners) {
  $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $($Listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($Process -and $Process.Name -eq "node.exe" -and $Process.CommandLine -match $EscapedRoot -and $Process.CommandLine -match "vite") {
    Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
`;
    await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps]);
    return;
  }

  await run("sh", [
    "-c",
    `
ROOT=${shellQuote(root)}
if command -v lsof >/dev/null 2>&1; then
  for PID in $(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null); do
    CMD=$(ps -p "$PID" -o command= 2>/dev/null || true)
    case "$CMD" in
      *"$ROOT"*vite*) kill "$PID" 2>/dev/null || true ;;
    esac
  done
fi
`,
  ]);
}

await stopStaleVite();

await new Promise((resolve) => setTimeout(resolve, 250));

const command = os.platform() === "win32" ? "cmd.exe" : "npm";
const args = os.platform() === "win32" ? ["/d", "/s", "/c", "npm run dev"] : ["run", "dev"];
const child = spawn(command, args, {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
