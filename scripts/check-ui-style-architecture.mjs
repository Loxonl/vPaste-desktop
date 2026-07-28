import { readFileSync, readdirSync } from "node:fs";
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
for (const label of ["config", "clipboardPreview", "trayMenu", "emojiPicker", "tabEditor"]) {
    const builder = mainRust.match(
        new RegExp(`WebviewWindowBuilder::new\\([\\s\\S]{0,300}?"${label}"[\\s\\S]{0,3000}?\\.build\\(`),
    )?.[0];
    if (!builder?.includes(".transparent(true)") || !builder.includes(".shadow(false)")) {
        errors.push(
            `src-tauri/src/main.rs: transparent auxiliary window "${label}" must disable the native shadow`,
        );
    }
}

if (!mainRust.match(/#\[cfg\(target_os = "windows"\)\][\s\S]{0,120}include_bytes!\("\.\.\/icons\/tray-icon\.png"\)/)) {
    errors.push("src-tauri/src/main.rs: Windows must keep the colored tray-icon.png asset");
}

if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
}

console.log("UI style architecture check passed.");
