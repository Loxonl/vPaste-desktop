import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("preserves packages and validation material when compacting release assets", () => {
  const python = process.platform === "win32" ? "python" : "python3";
  expect(() => execFileSync(python, [
    "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_release_assets.py",
  ], { stdio: "pipe" })).not.toThrow();
});
