import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const sourceRoot = join(root, "src");
const allowedGlobalCss = new Set([
    join(sourceRoot, "theme.css"),
    join(sourceRoot, "ui", "tokens.css"),
]);
const governanceBaseline = JSON.parse(
    readFileSync(join(root, "scripts", "ui-governance-baseline.json"), "utf8"),
);
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

function displayPath(path) {
    return relative(root, path).replaceAll("\\", "/");
}

function countByValue(values) {
    return Object.fromEntries(
        [...new Set(values)].sort().map(value => [
            value,
            values.filter(candidate => candidate === value).length,
        ]),
    );
}

function compareBaseline(label, expected, actual) {
    const paths = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const path of paths) {
        const expectedValue = expected[path] ?? {};
        const actualValue = actual[path] ?? {};
        const normalizedExpected = typeof expectedValue === "object"
            ? Object.fromEntries(Object.entries(expectedValue).sort())
            : expectedValue;
        const normalizedActual = typeof actualValue === "object"
            ? Object.fromEntries(Object.entries(actualValue).sort())
            : actualValue;
        if (JSON.stringify(normalizedExpected) !== JSON.stringify(normalizedActual)) {
            errors.push(
                `${path}: ${label} changed; expected ${JSON.stringify(normalizedExpected)}, received ${JSON.stringify(normalizedActual)}. Migrate the control/motion to the shared system and shrink scripts/ui-governance-baseline.json in the same PR`,
            );
        }
    }
}

const rawControls = {};
const cssMotion = {};
const scriptMotion = {};
const legacyWebAnimations = {};

for (const path of walk(sourceRoot)) {
    const sourcePath = displayPath(path);
    const extension = extname(path);

    if (extension === ".css") {
        if (!path.endsWith(".module.css") && !allowedGlobalCss.has(path)) {
            errors.push(`${sourcePath}: page styles must use CSS Modules`);
        }

        if (path.endsWith(".module.css") && readFileSync(path, "utf8").includes(".Mui")) {
            errors.push(`${sourcePath}: MUI internals belong in src/ui/appTheme.ts`);
        }

        const source = readFileSync(path, "utf8");
        const motionDeclarations = [...source.matchAll(
            /\b(?:transition(?:-duration|-property|-timing-function)?|animation(?:-duration|-name|-timing-function)?)\s*:\s*[^;}{]+/g,
        )]
            .map(match => match[0].replace(/\s+/g, " ").trim())
            .filter(declaration => declaration !== "transition: none")
            .filter(declaration => !declaration.includes("var(--motion-"));
        if (motionDeclarations.length > 0) {
            cssMotion[sourcePath] = countByValue(motionDeclarations);
        }
    }

    if (extension === ".ts" || extension === ".tsx") {
        const source = readFileSync(path, "utf8");
        const directMotionImport = /(?:from\s*|import\s*(?:\(\s*)?)["'](?:motion(?:\/[^"']*)?|framer-motion(?:\/[^"']*)?)["']/g;
        for (const match of source.matchAll(directMotionImport)) {
            if (!sourcePath.startsWith("src/ui/motion/")) {
                errors.push(
                    `${sourcePath}:${lineNumberAt(source, match.index)}: import Motion only through src/ui/motion`,
                );
            }
        }

        if (extension === ".tsx") {
            const counts = {};
            for (const tag of ["button", "input", "select"]) {
                const count = [...source.matchAll(new RegExp(`<${tag}(?:\\s|>)`, "g"))].length;
                if (count > 0) counts[tag] = count;
            }
            if (Object.keys(counts).length > 0) rawControls[sourcePath] = counts;

            for (const match of source.matchAll(/<AnimatePresence\b([^>]*)>/g)) {
                if (!/\bmode\s*=/.test(match[1])) {
                    errors.push(
                        `${sourcePath}:${lineNumberAt(source, match.index)}: AnimatePresence must declare mode explicitly`,
                    );
                }
            }
        }

        const scriptedDeclarations = [...source.matchAll(
            /\b(?:transition|duration|easing)\s*:\s*(?:"[^"]*"|'[^']*'|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/g,
        )]
            .map(match => match[0].replace(/\s+/g, " ").trim())
            .filter(declaration => !declaration.includes("var(--motion-"))
            .filter(declaration => !declaration.endsWith(": motionTokens"))
            .filter(declaration => !declaration.endsWith(": motionSprings"));
        if (scriptedDeclarations.length > 0 && !sourcePath.startsWith("src/ui/motion/")) {
            scriptMotion[sourcePath] = countByValue(scriptedDeclarations);
        }

        const animateCalls = [...source.matchAll(/\.animate\s*\(/g)].length;
        if (animateCalls > 0) legacyWebAnimations[sourcePath] = animateCalls;

        const importsCssModuleStyles = /import\s+styles\s+from\s+["'][^"']+\.module\.css["']/.test(source);
        if (!importsCssModuleStyles) continue;

        const rawSelector = /\.(?:closest|querySelector|querySelectorAll)\s*(?:<[^>]+>)?\s*\(\s*["']\.[^"']+["']/g;
        for (const match of source.matchAll(rawSelector)) {
            errors.push(
                `${sourcePath}:${lineNumberAt(source, match.index)}: CSS Module selectors must use the imported styles mapping`,
            );
        }

        const rawClassNameAssignment = /\.className\s*=\s*["'][^"']+["']/g;
        for (const match of source.matchAll(rawClassNameAssignment)) {
            errors.push(
                `${sourcePath}:${lineNumberAt(source, match.index)}: CSS Module className assignments must use the imported styles mapping`,
            );
        }
    }
}

compareBaseline("native interactive-control baseline", governanceBaseline.rawControls, rawControls);
compareBaseline("hard-coded CSS motion baseline", governanceBaseline.cssMotion, cssMotion);
compareBaseline("hard-coded script motion baseline", governanceBaseline.scriptMotion, scriptMotion);
compareBaseline("Web Animations API baseline", governanceBaseline.legacyWebAnimations, legacyWebAnimations);

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
};
if (Object.keys(dependencies).some(name => name === "tailwindcss" || name.startsWith("@tailwindcss/"))) {
    errors.push("package.json: Tailwind must not be layered on top of the MUI design system");
}
if (Object.hasOwn(dependencies, "framer-motion")) {
    errors.push("package.json: do not depend on framer-motion directly; Motion is consumed through motion/react");
}
if (dependencies.motion && dependencies.motion !== "^13.1.0") {
    errors.push("package.json: Motion must use the reviewed React 18-compatible range ^13.1.0");
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
    "src-tauri/icons/source/vpaste-app-icon-1024.png": "9a1ab9280e1d45032b20257b11dcc41e6e300c54982445cec80c0888fb00b9d8",
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
