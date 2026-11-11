export function parseDevDebugOptions(args, platform, environment = {}) {
  let mainUi = "webview";
  let supplied = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let value;
    if (argument === "--main-ui") value = args[++index];
    else if (argument.startsWith("--main-ui=")) value = argument.slice("--main-ui=".length);
    else throw new Error(`Unknown developer option: ${argument}. Use --main-ui=native, --main-ui=winui, or --main-ui=webview.`);
    if (supplied) throw new Error("Specify --main-ui only once.");
    if (!["native", "winui", "webview"].includes(value)) {
      throw new Error("--main-ui must be native, winui, or webview.");
    }
    mainUi = value;
    supplied = true;
  }
  // npm consumes options placed before its `--` separator and exposes them as
  // npm_config_* instead of argv. Explicit script arguments take precedence.
  if (!supplied && environment.npm_config_main_ui !== undefined) {
    mainUi = environment.npm_config_main_ui;
    if (!["native", "winui", "webview"].includes(mainUi)) {
      throw new Error("--main-ui must be native, winui, or webview.");
    }
  }
  if (mainUi === "native" && platform !== "darwin") {
    throw new Error("The native main interface is available in macOS DEV builds only.");
  }
  if (mainUi === "winui" && platform !== "win32") {
    throw new Error("The WinUI 3 main interface is available in Windows DEV builds only.");
  }
  return { mainUi, appArgs: ["--dev-mode", `--main-ui=${mainUi}`] };
}
