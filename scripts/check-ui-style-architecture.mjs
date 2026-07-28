import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const sourceRoot = join(root, "src");
const allowedGlobalCss = new Set([
    join(sourceRoot, "theme.css"),
    join(sourceRoot, "ui", "tokens.css"),
]);
const errors = [];

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });
}

function lineNumberAt(source, index) {
    return source.slice(0, index).split("\n").length;
}

for (const path of walk(sourceRoot)) {
    const displayPath = relative(root, path);
    const extension = extname(path);

    if (extension === ".css") {
        if (!path.endsWith(".module.css") && !allowedGlobalCss.has(path)) {
            errors.push(`${displayPath}: page styles must use CSS Modules`);
        }

        if (path.endsWith(".module.css") && readFileSync(path, "utf8").includes(".Mui")) {
            errors.push(`${displayPath}: MUI internals belong in src/ui/appTheme.ts`);
        }
    }

    if (extension === ".ts" || extension === ".tsx") {
        const source = readFileSync(path, "utf8");
        const importsCssModuleStyles = /import\s+styles\s+from\s+["'][^"']+\.module\.css["']/.test(source);
        if (!importsCssModuleStyles) continue;

        const rawSelector = /\.(?:closest|querySelector|querySelectorAll)\s*(?:<[^>]+>)?\s*\(\s*["']\.[^"']+["']/g;
        for (const match of source.matchAll(rawSelector)) {
            errors.push(
                `${displayPath}:${lineNumberAt(source, match.index)}: CSS Module selectors must use the imported styles mapping`,
            );
        }

        const rawClassNameAssignment = /\.className\s*=\s*["'][^"']+["']/g;
        for (const match of source.matchAll(rawClassNameAssignment)) {
            errors.push(
                `${displayPath}:${lineNumberAt(source, match.index)}: CSS Module className assignments must use the imported styles mapping`,
            );
        }
    }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
};
if (Object.keys(dependencies).some(name => name === "tailwindcss" || name.startsWith("@tailwindcss/"))) {
    errors.push("package.json: Tailwind must not be layered on top of the MUI design system");
}

const mainRustPath = join(root, "src-tauri", "src", "main.rs");
const mainRust = readFileSync(mainRustPath, "utf8");
const buildRust = readFileSync(join(root, "src-tauri", "build.rs"), "utf8");
const uiTokens = readFileSync(join(root, "src", "ui", "tokens.css"), "utf8");
for (const label of ["clipboardPreview", "trayMenu", "emojiPicker", "tabEditor"]) {
    const builder = mainRust.match(
        new RegExp(`WebviewWindowBuilder::new\\([\\s\\S]{0,300}?"${label}"[\\s\\S]{0,3000}?\\.build\\(`),
    )?.[0];
    if (!builder?.includes(".transparent(true)") || !builder.includes(".shadow(false)")) {
        errors.push(
            `src-tauri/src/main.rs: transparent auxiliary window "${label}" must disable the native shadow`,
        );
    }
}

const configBuilder = mainRust.match(
    /WebviewWindowBuilder::new\([\s\S]{0,300}?"config"[\s\S]{0,3000}?\.build\(/,
)?.[0];
if (!configBuilder?.includes(".transparent(true)") || !configBuilder.includes(".shadow(false)")) {
    errors.push("src-tauri/src/main.rs: Windows settings must disable the conflicting native shadow");
}
if (mainRust.match(
    /apply_acrylic\(&config_window|apply_windows_rounded_window_region\(&(config_window|tray_menu_window)/,
)) {
    errors.push("src-tauri/src/main.rs: CSS-owned window surfaces must not add a second native rounded surface");
}
if (!buildRust.includes("const TRAY_ICON_SCALE: f32 = 1.1;")) {
    errors.push("src-tauri/build.rs: tray SVG mask must retain the approved 1.1x centered scale");
}
if (!mainRust.includes("const TRAY_ACCENT_RGBA: [u8; 4] = [11, 134, 255, 255];")) {
    errors.push("src-tauri/src/main.rs: Windows tray must use the logo gradient middle stop #0B86FF");
}
for (const token of ["--ui-radius-window: 12px", "--ui-window-shadow: 0 2px 6px"]) {
    if (!uiTokens.includes(token)) {
        errors.push(`src/ui/tokens.css: missing shared auxiliary-window token "${token}"`);
    }
}

if (!mainRust.includes('include_bytes!(concat!(env!("OUT_DIR"), "/vpaste-tray.rgba"))')) {
    errors.push("src-tauri/src/main.rs: tray icons must use the SVG-derived build mask");
}

for (const legacyPath of [
    "public/favicon.png",
    "src/assets/vpaste-app-icon.png",
    "src-tauri/icons/logo-borderless.png",
    "src-tauri/icons/tray-icon.png",
    "src-tauri/icons/tray-icon-light.png",
    "src-tauri/icons/tray-icon-dark.png",
]) {
    if (existsSync(join(root, legacyPath))) {
        errors.push(`${legacyPath}: remove legacy or duplicate icon asset`);
    }
}

const canonicalBrandSources = {
    "src/assets/vpaste-logo-master.svg": "21c01d4a93ee88837d0d5c43735ec1e294cac887b40bbdb62bd3dd801236fb48",
    "src-tauri/icons/source/vpaste-tray.svg": "363ec8c8c48609879d2fd35d1c15285896c9177146fe5239c73a17a3e800040e",
    "src-tauri/icons/source/vpaste-app-icon-1024.png": "d035aba858facc318d2906fabd0ecb8e6117b724c9308ab783b71c79340a93d7",
};
for (const [sourcePath, expectedHash] of Object.entries(canonicalBrandSources)) {
    const absolutePath = join(root, sourcePath);
    if (!existsSync(absolutePath)) {
        errors.push(`${sourcePath}: canonical brand source is missing`);
        continue;
    }
    const actualHash = createHash("sha256")
        .update(readFileSync(absolutePath))
        .digest("hex");
    if (actualHash !== expectedHash) {
        errors.push(`${sourcePath}: canonical brand source does not match the approved asset`);
    }
}

if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
}

console.log("UI style architecture check passed.");
