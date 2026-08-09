import materialIconManifest from "material-icon-theme/dist/material-icons.json";
import type { ResolvedTheme } from "../theme";

type IconAssociations = {
    fileExtensions?: Record<string, string>;
    fileNames?: Record<string, string>;
};

type MaterialIconManifest = IconAssociations & {
    iconDefinitions: Record<string, { iconPath?: string }>;
    light?: IconAssociations;
};

export type ResolvedFileTypeIcon = {
    name: string;
    url: string;
};

const manifest = materialIconManifest as MaterialIconManifest;
const materialIconUrls = import.meta.glob(
    "/node_modules/material-icon-theme/icons/*.svg",
    { eager: true, query: "?no-inline", import: "default" },
) as Record<string, string>;
const iconUrlByFileName = new Map(
    Object.entries(materialIconUrls).map(([path, url]) => [path.split("/").pop() || "", url]),
);

function extensionCandidates(fileName: string): string[] {
    const segments = fileName.split(".");
    if (segments.length < 2) return [];
    return segments.slice(1).map((_, index) => segments.slice(index + 1).join("."));
}

function associationForKey(
    kind: keyof IconAssociations,
    key: string,
    theme: ResolvedTheme,
): string | undefined {
    const themedAssociations = theme === "light" ? manifest.light?.[kind] : undefined;
    return themedAssociations?.[key] ?? manifest[kind]?.[key];
}

function iconNameForPath(path: string, theme: ResolvedTheme): string | undefined {
    const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
    const fileName = (segments[segments.length - 1] || "").toLowerCase();
    if (!fileName) return undefined;

    const parentName = segments.length > 1
        ? segments[segments.length - 2].toLowerCase()
        : undefined;
    if (parentName) {
        const parentFileName = associationForKey("fileNames", `${parentName}/${fileName}`, theme);
        if (parentFileName) return parentFileName;
    }

    const exactFileName = associationForKey("fileNames", fileName, theme);
    if (exactFileName) return exactFileName;

    for (const extension of extensionCandidates(fileName)) {
        if (parentName) {
            const parentExtension = associationForKey(
                "fileExtensions",
                `${parentName}/${extension}`,
                theme,
            );
            if (parentExtension) return parentExtension;
        }

        const iconName = associationForKey("fileExtensions", extension, theme);
        if (iconName) return iconName;
    }

    return undefined;
}

export function resolveFileTypeIcon(
    path: string,
    theme: ResolvedTheme,
): ResolvedFileTypeIcon | null {
    const name = iconNameForPath(path, theme);
    return name ? resolveMaterialIcon(name) : null;
}

export function resolveMaterialIcon(name: string): ResolvedFileTypeIcon | null {
    const iconPath = manifest.iconDefinitions[name]?.iconPath;
    const iconFileName = iconPath?.split("/").pop();
    const url = iconFileName ? iconUrlByFileName.get(iconFileName) : undefined;
    return url ? { name, url } : null;
}
