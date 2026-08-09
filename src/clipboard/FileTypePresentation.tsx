import { useTheme } from "@mui/material/styles";
import type { FilePreviewInfo } from "./itemPresentation";
import { resolveFileTypeIcon, resolveMaterialIcon } from "./fileTypeIcons";
import styles from "./FileTypePresentation.module.css";

type FilePresentationMode = "known" | "unknown" | "folder" | "multiple" | "mixed";

type FileTypePresentationProps = {
    path: string;
    extension: string;
    kind: FilePreviewInfo["kind"];
    containsDirectories?: boolean;
    multipleLabel: string;
    variant: "card" | "preview";
};

const DOCUMENT_GLYPH_PATH = "M8 16h8v2H8zm0-4h8v2H8zm6-10H6C4.9 2 4 2.9 4 4v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm4 18H6V4h7v5h5z";
const FOLDER_GLYPH_PATH = "m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232";

function MultipleFilesGlyph() {
    return (
        <svg
            className={`${styles.icon} ${styles.multipleIcon}`}
            data-file-stack="m5"
            viewBox="0 0 76 60"
            aria-hidden="true"
            focusable="false"
        >
            <svg data-file-stack-layer x="0" y="6" width="54" height="54" viewBox="0 0 24 24" opacity="0.48">
                <path fill="#42a5f5" d={DOCUMENT_GLYPH_PATH} />
            </svg>
            <svg data-file-stack-layer x="11" y="4" width="54" height="54" viewBox="0 0 24 24" opacity="0.72">
                <path fill="#42a5f5" d={DOCUMENT_GLYPH_PATH} />
            </svg>
            <svg data-file-stack-layer x="22" y="2" width="54" height="54" viewBox="0 0 24 24">
                <path fill="#42a5f5" d={DOCUMENT_GLYPH_PATH} />
            </svg>
        </svg>
    );
}

function YellowFolderGlyph() {
    return (
        <svg
            className={styles.icon}
            data-file-folder-icon="yellow"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
        >
            <path fill="#fbc02d" d={FOLDER_GLYPH_PATH} />
        </svg>
    );
}

function TextDocumentGlyph() {
    return (
        <svg
            className={styles.icon}
            data-file-text-document="lined"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
        >
            <path
                fill="#42a5f5"
                d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2"
            />
            <path fill="#e3f2fd" d="M14 2v5h5z" />
            <path fill="#fff" d="M7 10h9v1.6H7zm0 3.5h9v1.6H7zM7 17h6.5v1.6H7z" />
        </svg>
    );
}

function extensionLabel(path: string, extension: string): string {
    const explicitExtension = extension.trim().replace(/^\./, "");
    if (explicitExtension) return explicitExtension.toUpperCase();

    const fileName = path.split(/[\\/]/).filter(Boolean).pop() || "";
    const dotIndex = fileName.lastIndexOf(".");
    return dotIndex > 0 && dotIndex < fileName.length - 1
        ? fileName.slice(dotIndex + 1).toUpperCase()
        : "FILE";
}

export function FileTypePresentation({
    path,
    extension,
    kind,
    containsDirectories = false,
    multipleLabel,
    variant,
}: FileTypePresentationProps) {
    const theme = useTheme();
    const isMultiple = kind === "multiple";
    const isFolder = kind === "single-folder";
    const isMixed = isMultiple && containsDirectories;
    const mappedIcon = !isMultiple && !isFolder
        ? resolveFileTypeIcon(path, theme.palette.mode)
        : null;
    const label = isFolder ? "" : isMultiple ? multipleLabel : extensionLabel(path, extension);
    const isTextDocument = mappedIcon?.name === "document" && label === "TXT";

    let mode: FilePresentationMode;
    if (isFolder) mode = "folder";
    else if (isMixed) mode = "mixed";
    else if (isMultiple) mode = "multiple";
    else if (mappedIcon) mode = "known";
    else mode = "unknown";

    const icon = isFolder
        ? resolveMaterialIcon("folder")
        : isMixed
            ? resolveMaterialIcon("folder-resource")
            : mappedIcon || resolveMaterialIcon("document");
    const className = `${styles.presentation} ${styles[variant]}`;

    return (
        <div
            className={className}
            data-file-presentation={mode}
            data-file-icon-name={isTextDocument
                ? "text-document"
                : isMultiple && !isMixed
                    ? "document"
                    : icon?.name}
        >
            {isMultiple && !isMixed ? (
                <MultipleFilesGlyph />
            ) : isFolder && icon ? (
                <YellowFolderGlyph />
            ) : isTextDocument ? (
                <TextDocumentGlyph />
            ) : icon ? (
                <img className={styles.icon} src={icon.url} alt="" draggable={false} />
            ) : null}
            {label && <span className={styles.label}>{label}</span>}
        </div>
    );
}
