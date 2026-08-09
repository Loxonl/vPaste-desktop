import { describe, expect, it } from "vitest";
import {
    resolveFileTypeIcon,
    resolveMaterialIcon,
} from "../../../src/clipboard/fileTypeIcons";

describe("file type icon resolution", () => {
    it("resolves common extensions case-insensitively", () => {
        expect(resolveFileTypeIcon("C:\\Documents\\REPORT.PDF", "dark")?.name).toBe("pdf");
    });

    it("prefers exact file names and compound extensions", () => {
        expect(resolveFileTypeIcon("/workspace/Dockerfile", "dark")?.name).toBe("docker");
        expect(resolveFileTypeIcon("/workspace/index.d.ts", "dark")?.name).toBe("typescript-def");
    });

    it("leaves unknown extensions for the generic fallback", () => {
        expect(resolveFileTypeIcon("C:\\Documents\\archive.unknownxyz", "dark")).toBeNull();
    });

    it("resolves the shared document and folder presentation icons", () => {
        expect(resolveMaterialIcon("document")?.name).toBe("document");
        expect(resolveMaterialIcon("folder")?.name).toBe("folder");
        expect(resolveMaterialIcon("folder-resource")?.name).toBe("folder-resource");
    });
});
