const MAC_PLATFORM_PATTERNS = ["mac", "darwin", "os x"];

type NavigatorWithUserAgentData = Navigator & {
    userAgentData?: {
        platform?: string;
    };
};

function platformString(): string {
    if (typeof navigator === "undefined") return "";

    const currentNavigator = navigator as NavigatorWithUserAgentData;
    const userAgentDataPlatform = currentNavigator.userAgentData?.platform;
    if (typeof userAgentDataPlatform === "string") {
        return userAgentDataPlatform.toLowerCase();
    }

    return (navigator.platform || "").toLowerCase();
}

export function isMacPlatform(): boolean {
    const platform = platformString();
    return MAC_PLATFORM_PATTERNS.some(pattern => platform.includes(pattern));
}

export function getModifierDisplayLabel(modifier: string, macPlatform = isMacPlatform()): string {
    const normalized = modifier.trim().toLowerCase();

    if (normalized === "control" || normalized === "ctrl") return "Ctrl";
    if (normalized === "alt") return macPlatform ? "Option" : "Alt";
    if (normalized === "shift") return "Shift";
    if (normalized === "command" || normalized === "meta" || normalized === "cmd") return "Command";
    if (normalized === "super" || normalized === "win" || normalized === "windows") return macPlatform ? "Command" : "Win";
    return modifier;
}

export function formatShortcutLabel(value?: string, macPlatform = isMacPlatform()): string {
    if (!value) return "";

    return value
        .split("+")
        .map(part => {
            const normalized = part.trim().toLowerCase();
            if (["control", "ctrl", "alt", "shift", "command", "meta", "cmd", "super", "win", "windows"].includes(normalized)) {
                return getModifierDisplayLabel(part, macPlatform);
            }
            if (normalized === "enter" || normalized === "return") return "Enter";
            if (normalized === "escape" || normalized === "esc") return "Esc";
            if (normalized === " ") return "Space";
            if (part.length === 1) return part.toUpperCase();
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        })
        .join(" + ");
}
