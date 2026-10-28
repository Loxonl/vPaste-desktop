import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

const MODULE = "virtual:file-type-icon-index";
const RESOLVED_MODULE = `\0${MODULE}`;
const ASSET_PATH = "__vpaste_file_icons__/";

type Associations = {
    fileExtensions?: Record<string, string>;
    fileNames?: Record<string, string>;
};
type Manifest = Associations & {
    iconDefinitions: Record<string, { iconPath: string }>;
    light?: Associations;
};

/** Serve SVG bytes as assets, without a JavaScript module per icon in DEV. */
export function fileTypeIconsPlugin(): Plugin {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve("material-icon-theme/dist/material-icons.json");
    const directory = path.resolve(path.dirname(manifestPath), "../icons");
    const original = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    const filenames = readdirSync(directory).filter(name => name.endsWith(".svg")).sort();
    const available = new Set(filenames);
    const associations = (value: Associations | undefined): Associations => ({
        fileExtensions: value?.fileExtensions,
        fileNames: value?.fileNames,
    });
    const manifest: Manifest = {
        ...associations(original),
        light: associations(original.light),
        iconDefinitions: Object.fromEntries(Object.entries(original.iconDefinitions).map(([name, value]) => [
            name, { iconPath: path.posix.basename(value.iconPath) },
        ])),
    };
    let config: ResolvedConfig;
    const devPrefix = () => {
        const base = config.base.startsWith(".") ? "/" : new URL(config.base, "http://localhost").pathname;
        return `${base.endsWith("/") ? base : `${base}/`}${ASSET_PATH}`;
    };
    return {
        name: "vpaste-file-type-icon-assets",
        configResolved(value) { config = value; },
        resolveId(id) { return id === MODULE ? RESOLVED_MODULE : undefined; },
        load(id) {
            if (id !== RESOLVED_MODULE) return undefined;
            const entries = filenames.map(filename => {
                const expression = config.command === "build"
                    ? `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: "asset", name: filename, source: readFileSync(path.join(directory, filename)) })}`
                    : JSON.stringify(`${devPrefix()}${encodeURIComponent(filename)}`);
                return `${JSON.stringify(filename)}:${expression}`;
            });
            return `export const manifest=${JSON.stringify(manifest)};\nexport const iconUrls={${entries.join(",")}};`;
        },
        configureServer(server) {
            server.middlewares.use(devPrefix(), (request, response, next) => {
                let filename: string;
                try {
                    filename = decodeURIComponent((request.url || "").split("?")[0].replace(/^\//, ""));
                } catch {
                    response.statusCode = 400;
                    response.end();
                    return;
                }
                if (!available.has(filename)) {
                    response.statusCode = 404;
                    response.end();
                    return;
                }
                const asset = path.join(directory, filename);
                const stat = statSync(asset);
                const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
                response.setHeader("Content-Type", "image/svg+xml");
                response.setHeader("Cache-Control", "no-cache");
                response.setHeader("ETag", etag);
                if (request.headers["if-none-match"] === etag) {
                    response.statusCode = 304;
                    response.end();
                    return;
                }
                response.setHeader("Content-Length", stat.size);
                if (request.method === "HEAD") { response.end(); return; }
                const stream = createReadStream(asset);
                stream.on("error", next);
                stream.pipe(response);
            });
        },
    };
}
