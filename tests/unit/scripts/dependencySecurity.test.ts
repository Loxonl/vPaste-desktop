import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8");
const packages = Array.from(
  cargoLock.matchAll(/^\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/gm),
  match => ({ name: match[1], version: match[2] }),
);

// Patched floors for GHSA-82j2-j2ch-gfr8 and GHSA-2mjx-qc3c-rqvc.
const patchedTlsVersions: [string, [number, number, number]][] = [
  ["rustls-webpki", [0, 103, 13]],
  ["rustls", [0, 23, 45]],
];

describe("locked TLS dependency security", () => {
  it.each(patchedTlsVersions)("%s resolves only patched versions", (name, minimum) => {
    const resolved = packages.filter(pkg => pkg.name === name);
    expect(resolved.length).toBeGreaterThan(0);

    for (const pkg of resolved) {
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
      const actual = pkg.version.split(".").map(Number);
      const atLeastMinimum =
        actual[0] > minimum[0] ||
        (actual[0] === minimum[0] && actual[1] > minimum[1]) ||
        (actual[0] === minimum[0] && actual[1] === minimum[1] && actual[2] >= minimum[2]);

      expect(atLeastMinimum, `${name}@${pkg.version} is below ${minimum.join(".")}`).toBe(true);
    }
  });
});
