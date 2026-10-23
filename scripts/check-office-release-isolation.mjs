import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "tests/fixtures/office");
const catalog = JSON.parse(readFileSync(join(fixtures, "catalog.json"), "utf8"));
const markers = [catalog.marker, "vPaste-Office.docx", "vPaste-Office.xlsx", ...catalog.cases.filter(testCase => testCase.id.startsWith("office-")).map(testCase => testCase.id)];
function checkText(path) {
    const text = readFileSync(path, "utf8");
    if (markers.some(marker => text.includes(marker))) throw new Error(`Office fixture found in Release assets: ${path}`);
}
function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (/\.(js|html|json|docx|xlsx)$/.test(entry.name)) checkText(path);
    }
}
const distFlag = process.argv.indexOf("--dist");
if (distFlag >= 0 && !process.argv[distFlag + 1]) throw new Error("--dist requires a built frontend directory.");
scan(distFlag >= 0 ? resolve(process.argv[distFlag + 1]) : join(root, "dist"));
const binaryFlag = process.argv.indexOf("--binary");
if (binaryFlag >= 0) {
    const binary = process.argv[binaryFlag + 1];
    if (!binary) throw new Error("--binary requires a built Release executable path.");
    const path = resolve(binary);
    const bytes = readFileSync(path);
    const names = ["large-picture.png", "vPaste-Office.docx", "vPaste-Office.xlsx"];
    if (markers.some(marker => bytes.includes(Buffer.from(marker))) || names.some(name => bytes.includes(readFileSync(join(fixtures, name))))) {
        throw new Error("Office fixture data found in the Release executable.");
    }
    console.log(JSON.stringify({ releaseBinaryBytes: statSync(path).size, officeFixtureData: "excluded" }));
}
console.log("Office fixture isolation passed.");
