import { readFileSync } from "node:fs";
const catalog: typeof import("../fixtures/office/catalog.json") = JSON.parse(
    readFileSync(new URL("../fixtures/office/catalog.json", import.meta.url), "utf8"),
);

export { catalog as officeCatalog };

export function officeHtml(caseId: string, secondPicture = false): string {
    const testCase = catalog.cases.find(candidate => candidate.id === caseId);
    if (!testCase) throw new Error(`Unknown Office case: ${caseId}`);
    const template = secondPicture
        ? testCase.html.replace("{{pictureA}}", "{{pictureB}}").replace("width=160 height=96", "width=120 height=80")
        : testCase.html;
    return catalog.images.reduce((html, fixture) => html.split(`{{${fixture.key}}}`).join(
        `data:image/png;base64,${readFileSync(new URL(`../fixtures/office/${fixture.file}`, import.meta.url)).toString("base64")}`,
    ), template);
}
