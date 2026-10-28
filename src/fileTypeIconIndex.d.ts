declare module "virtual:file-type-icon-index" {
    type Associations = {
        fileExtensions?: Record<string, string>;
        fileNames?: Record<string, string>;
    };
    export const manifest: Associations & {
        iconDefinitions: Record<string, { iconPath: string }>;
        light?: Associations;
    };
    export const iconUrls: Record<string, string>;
}
