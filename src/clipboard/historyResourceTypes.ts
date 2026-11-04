import { convertFileSrc } from "@tauri-apps/api/core";

export type RichImageResource = { token: string; assetPath: string; revision: string };
export type RichRenderPayload = { html: string; resources: RichImageResource[] };

export function richResourceUrls(resources: readonly RichImageResource[]): ReadonlyMap<string, string> {
    return new Map(resources.map(resource => [resource.token, convertFileSrc(resource.assetPath)]));
}
