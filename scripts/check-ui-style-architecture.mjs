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

for (const path of walk(sourceRoot)) {
    const displayPath = relative(root, path);

    if (extname(path) === ".css") {
        if (!path.endsWith(".module.css") && !allowedGlobalCss.has(path)) {
            errors.push(`${displayPath}: page styles must use CSS Modules`);
        }

        if (path.endsWith(".module.css") && readFileSync(path, "utf8").includes(".Mui")) {
            errors.push(`${displayPath}: MUI internals belong in src/ui/appTheme.ts`);
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

if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
}

console.log("UI style architecture check passed.");
