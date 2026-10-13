import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";

const directory = resolve(fileURLToPath(new URL("../src-tauri/macos/dmg/", import.meta.url)));
const source = await readFile(resolve(directory, "background.svg"), "utf8");
const layout = JSON.parse(await readFile(resolve(directory, "layout.json"), "utf8"));
const { width, height } = layout.windowSize;
const svgSize = source.match(/<svg[^>]*width="(\d+)" height="(\d+)"/);
if (!svgSize || Number(svgSize[1]) !== width || Number(svgSize[2]) !== height) {
  throw new Error(`background.svg must be ${width}x${height} to match layout.json`);
}
const browser = await chromium.launch({ headless: true });

try {
  for (const scale of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    await page.setContent(`<style>html,body{margin:0}</style>${source}`);
    const suffix = scale === 1 ? "" : "@2x";
    await page.screenshot({ path: resolve(directory, `background${suffix}.png`) });
    await context.close();
  }
} finally {
  await browser.close();
}
