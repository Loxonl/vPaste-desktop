import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const trustedSha = "a".repeat(40);

function validate(sourceSha: string, githubSha = trustedSha, githubRef = "refs/heads/main") {
    return spawnSync(process.execPath, ["scripts/validate-release-source.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
            ...process.env,
            SOURCE_SHA: sourceSha,
            GITHUB_SHA: githubSha,
            GITHUB_REF: githubRef,
        },
    });
}

describe("release source validation", () => {
    it("accepts only the selected main commit for the release build", () => {
        expect(validate(trustedSha).status).toBe(0);
        expect(validate("b".repeat(40)).status).not.toBe(0);
        expect(validate(trustedSha, trustedSha, "refs/heads/feature").status).not.toBe(0);
        expect(validate("not-a-sha").status).not.toBe(0);
    });
});
