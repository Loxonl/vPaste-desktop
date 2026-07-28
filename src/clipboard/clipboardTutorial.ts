import { ItemType } from "./Item";
import {
    DEFAULT_CUSTOM_FILTER,
    type CustomTab,
} from "./customTabs";

type TFunction = (
    key: string,
    params?: Record<string, string | number>,
) => string;

export type TutorialPermissionId = "background" | "paste";
export type TutorialFilterId = "text" | "image" | "link" | "color" | "file";
export type TutorialPlatform = "windows" | "mac";

export type TutorialPermissionStatus = {
    background: { done: boolean; needs_settings: boolean; error?: string | null };
    paste: { done: boolean; needs_settings: boolean; error?: string | null };
};

export type TutorialPermission = {
    id: TutorialPermissionId;
    title: string;
    description: string;
    done: boolean;
    actionLabel: string;
};

export type TutorialFilterTab = {
    id: TutorialFilterId;
    name: string;
    enabled: boolean;
};

export const PENDING_PERMISSION_WINDOW_KEY =
    "vpaste.pendingOnboardingPermission.v1";

export const TUTORIAL_FILTER_DEFINITIONS: Array<{
    id: TutorialFilterId;
    emoji: string;
    titleKey: string;
    itemType: ItemType;
}> = [
    { id: "text", emoji: "📝", titleKey: "type.text", itemType: ItemType.Text },
    { id: "image", emoji: "🖼️", titleKey: "type.image", itemType: ItemType.Image },
    { id: "link", emoji: "🔗", titleKey: "type.link", itemType: ItemType.Link },
    { id: "color", emoji: "🎨", titleKey: "type.color", itemType: ItemType.Color },
    { id: "file", emoji: "📁", titleKey: "type.file", itemType: ItemType.File },
];

export function tutorialFilterTabId(id: TutorialFilterId): string {
    return `tutorial-filter-${id}`;
}

function createTutorialFilterTab(
    id: TutorialFilterId,
    t: TFunction,
): CustomTab | null {
    const definition = TUTORIAL_FILTER_DEFINITIONS.find(
        filter => filter.id === id,
    );
    if (!definition) return null;
    return {
        id: tutorialFilterTabId(id),
        name: `${definition.emoji} ${t(definition.titleKey)}`,
        filter: {
            ...DEFAULT_CUSTOM_FILTER,
            itemType: definition.itemType,
        },
    };
}

export function updateTutorialFilterTabs(
    tabs: CustomTab[],
    id: TutorialFilterId,
    enabled: boolean,
    t: TFunction,
): CustomTab[] {
    const tabId = tutorialFilterTabId(id);
    const exists = tabs.some(tab => tab.id === tabId);
    if (enabled && !exists) {
        const tab = createTutorialFilterTab(id, t);
        return tab ? [...tabs, tab] : tabs;
    }
    if (!enabled && exists) {
        return tabs.filter(tab => tab.id !== tabId);
    }
    return tabs;
}

export function buildTutorialFilterTabs(
    tabs: CustomTab[],
    t: TFunction,
): TutorialFilterTab[] {
    return TUTORIAL_FILTER_DEFINITIONS.map(filter => ({
        id: filter.id,
        name: `${filter.emoji} ${t(filter.titleKey)}`,
        enabled: tabs.some(tab => tab.id === tutorialFilterTabId(filter.id)),
    }));
}

export function buildTutorialPermissions(
    status: TutorialPermissionStatus | null,
    t: TFunction,
): TutorialPermission[] {
    return [
        {
            id: "background",
            title: t("tutorial.permission.background"),
            description: t("tutorial.permission.background.desc"),
            done: status?.background.done === true,
            actionLabel: t("tutorial.permission.enable"),
        },
        {
            id: "paste",
            title: t("tutorial.permission.paste"),
            description: t("tutorial.permission.paste.desc"),
            done: status?.paste.done === true,
            actionLabel: t("tutorial.permission.openSettings"),
        },
    ];
}
