import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    compareReleaseVersions,
    decidePublication,
    publishUpdaterManifest,
} from "../../../scripts/publish-updater-manifest.mjs";

const TAG_URL = "https://github.com/Loxonl/vPaste-desktop/releases/download/v1.7.0";
const PACKAGES = {
    "windows-x86_64": "vPaste_1.7.0_windows_x64_setup.exe",
    "darwin-aarch64": "vPaste_1.7.0_macos_aarch64.app.tar.gz",
    "darwin-x86_64": "vPaste_1.7.0_macos_x86_64.app.tar.gz",
};
const TOKEN = "website-token-value";

type Manifest = { version: string; notes?: string; pub_date?: string; platforms: Record<string, { url: string; signature: string }> };

function manifestFor(version = "1.7.0"): Manifest {
    return {
        version,
        notes: "",
        pub_date: "2026-10-13T00:00:00Z",
        platforms: Object.fromEntries(Object.entries(PACKAGES).map(([platform, name]) => [
            platform,
            { url: `${TAG_URL}/${name}`, signature: `sig-${platform}` },
        ])),
    };
}

let assetsDir = "";

beforeEach(() => {
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpaste-feed-"));
    for (const [platform, name] of Object.entries(PACKAGES)) {
        fs.writeFileSync(path.join(assetsDir, name), `package-${platform}`);
        fs.writeFileSync(path.join(assetsDir, `${name}.sig`), `sig-${platform}`);
    }
});

afterEach(() => {
    fs.rmSync(assetsDir, { recursive: true, force: true });
});

type FakeRequest = { url: string; init?: RequestInit };

function fakeNetwork(options: {
    published?: Manifest | null;
    downloads?: Record<string, string | number>;
    putStatus?: number;
    publicManifest?: Manifest;
} = {}) {
    const requests: FakeRequest[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url.startsWith("https://api.github.com/")) {
            if (init?.method === "PUT") return new Response("{}", { status: options.putStatus ?? 200 });
            if (options.published === undefined || options.published === null) return new Response("", { status: 404 });
            return Response.json({
                sha: "remote-sha",
                content: Buffer.from(JSON.stringify(options.published)).toString("base64"),
            });
        }
        if (url.startsWith("https://vpaste.app/")) {
            return Response.json(options.publicManifest ?? manifestFor());
        }
        const name = decodeURIComponent(url.split("/").at(-1)!);
        const override = options.downloads?.[name];
        if (typeof override === "number") return new Response("", { status: override });
        return new Response(override ?? fs.readFileSync(path.join(assetsDir, name)));
    });
    return { fetchImpl, requests };
}

function publish(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof publishUpdaterManifest>[0]> = {}) {
    return publishUpdaterManifest({
        manifest: manifestFor(),
        channel: "stable",
        assetsDir,
        repo: "Loxonl/vPaste-website",
        branch: "main",
        token: TOKEN,
        publicUrl: "https://vpaste.app/download/stable/latest.json",
        fetchImpl,
        publicAttempts: 2,
        publicDelayMs: 0,
        sleep: async () => undefined,
        ...overrides,
    });
}

describe("website updater manifest publication", () => {
    it("orders stable and release-candidate versions", () => {
        expect(compareReleaseVersions("1.7.0-rc.1", "1.7.0")).toBe(-1);
        expect(compareReleaseVersions("1.7.0-rc.2", "1.7.0-rc.10")).toBe(-1);
        expect(compareReleaseVersions("1.10.0", "1.9.9")).toBe(1);
        expect(compareReleaseVersions("1.7.0", "1.7.0")).toBe(0);
    });

    it("verifies anonymous downloads before one conditional write and the public check", async () => {
        const previous = manifestFor("1.6.0");
        const { fetchImpl, requests } = fakeNetwork({ published: previous });

        await expect(publish(fetchImpl as unknown as typeof fetch)).resolves.toBe("update");

        const downloads = requests.filter(request => request.url.startsWith("https://github.com/"));
        expect(downloads).toHaveLength(3);
        for (const download of downloads) {
            expect(JSON.stringify(download.init ?? {})).not.toContain(TOKEN);
            expect(download.init?.credentials).toBe("omit");
        }
        const put = requests.find(request => request.init?.method === "PUT")!;
        expect(put.url).toBe("https://api.github.com/repos/Loxonl/vPaste-website/contents/download/stable/latest.json");
        const body = JSON.parse(String(put.init!.body));
        expect(body).toMatchObject({ branch: "main", sha: "remote-sha" });
        expect(JSON.parse(Buffer.from(body.content, "base64").toString("utf8")).version).toBe("1.7.0");
        const lastDownload = requests.lastIndexOf(downloads.at(-1)!);
        expect(requests.indexOf(put)).toBeGreaterThan(lastDownload);
        expect(requests.at(-1)!.url).toMatch(/^https:\/\/vpaste\.app\/download\/stable\/latest\.json/);
    });

    it.each([
        ["an unreachable package", { downloads: { [PACKAGES["darwin-x86_64"]]: 404 } }],
        ["a package that differs from the verified asset", { downloads: { [PACKAGES["windows-x86_64"]]: "tampered" } }],
    ])("keeps the published manifest when anonymous verification finds %s", async (_label, options) => {
        const { fetchImpl, requests } = fakeNetwork({ published: manifestFor("1.6.0"), ...options });

        await expect(publish(fetchImpl as unknown as typeof fetch)).rejects.toThrow(/Anonymous download/);
        expect(requests.some(request => request.init?.method === "PUT")).toBe(false);
    });

    it("refuses missing staged assets and mismatched signatures before any network access", async () => {
        fs.writeFileSync(path.join(assetsDir, `${PACKAGES["darwin-aarch64"]}.sig`), "other");
        const { fetchImpl } = fakeNetwork();
        await expect(publish(fetchImpl as unknown as typeof fetch)).rejects.toThrow(/signature does not match/);
        expect(fetchImpl).not.toHaveBeenCalled();

        fs.rmSync(path.join(assetsDir, PACKAGES["darwin-aarch64"]));
        await expect(publish(fetchImpl as unknown as typeof fetch)).rejects.toThrow(/missing/);
    });

    it("is idempotent for an identical re-run and creates a missing manifest", async () => {
        const same = { ...manifestFor(), pub_date: "2026-10-12T00:00:00Z" };
        const rerun = fakeNetwork({ published: same });
        await expect(publish(rerun.fetchImpl as unknown as typeof fetch)).resolves.toBe("unchanged");
        expect(rerun.requests.some(request => request.init?.method === "PUT")).toBe(false);

        const first = fakeNetwork({ published: null });
        await expect(publish(first.fetchImpl as unknown as typeof fetch)).resolves.toBe("create");
        const put = first.requests.find(request => request.init?.method === "PUT")!;
        expect(JSON.parse(String(put.init!.body)).sha).toBeUndefined();
    });

    it("blocks downgrades, same-version package swaps and concurrent writes", async () => {
        expect(() => decidePublication(manifestFor("1.7.1"), manifestFor("1.7.0"))).toThrow(/newer 1.7.1/);
        const swapped = manifestFor();
        swapped.platforms["windows-x86_64"].signature = "different";
        expect(() => decidePublication(swapped, manifestFor())).toThrow(/different packages/);
        expect(() => decidePublication({ unexpected: true }, manifestFor())).toThrow(/not a valid/);

        const conflict = fakeNetwork({ published: manifestFor("1.6.0"), putStatus: 409 });
        await expect(publish(conflict.fetchImpl as unknown as typeof fetch)).rejects.toThrow(/changed while publishing/);
    });

    it("keeps stable and release-candidate channels separate", async () => {
        const { fetchImpl } = fakeNetwork();
        await expect(publish(fetchImpl as unknown as typeof fetch, { channel: "rc" })).rejects.toThrow(/RC channel/);
        await expect(publish(fetchImpl as unknown as typeof fetch, {
            manifest: { ...manifestFor(), version: "1.7.0-rc.1" },
        })).rejects.toThrow(/Stable channel/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("fails when the public manifest never serves the new release", async () => {
        const { fetchImpl } = fakeNetwork({ published: manifestFor("1.6.0"), publicManifest: manifestFor("1.6.0") });
        await expect(publish(fetchImpl as unknown as typeof fetch)).rejects.toThrow(/did not serve 1.7.0/);
    });

    it("requires the website token", async () => {
        const { fetchImpl } = fakeNetwork();
        await expect(publish(fetchImpl as unknown as typeof fetch, { token: "" })).rejects.toThrow(/VPASTE_WEBSITE_RELEASE_TOKEN/);
    });
});
