export const WHITE_HEADER_TEXT_COLOR = "#fff";
export const MIN_WHITE_TEXT_CONTRAST = 4.5;

type RgbColor = {
    red: number;
    green: number;
    blue: number;
};

const FALLBACK_HEADER_COLOR: RgbColor = { red: 86, green: 94, blue: 104 };

function parseColor(color: string): RgbColor | null {
    const hex = color.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
    if (hex) {
        const expanded = hex.length === 3
            ? hex.split("").map(value => `${value}${value}`).join("")
            : hex;
        return {
            red: Number.parseInt(expanded.slice(0, 2), 16),
            green: Number.parseInt(expanded.slice(2, 4), 16),
            blue: Number.parseInt(expanded.slice(4, 6), 16),
        };
    }

    const rgb = color.trim().match(
        /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i,
    );
    if (!rgb) return null;

    const channels = rgb.slice(1, 4).map(Number);
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (channels.some(channel => channel < 0 || channel > 255) || alpha < 0 || alpha > 1) {
        return null;
    }

    return {
        red: channels[0] * alpha + 255 * (1 - alpha),
        green: channels[1] * alpha + 255 * (1 - alpha),
        blue: channels[2] * alpha + 255 * (1 - alpha),
    };
}

function formatColor(color: RgbColor): string {
    return `rgb(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)})`;
}

function relativeLuminance(color: RgbColor): number {
    const linear = [color.red, color.green, color.blue].map(channel => {
        const value = channel / 255;
        return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatioWithWhite(color: RgbColor): number {
    return 1.05 / (relativeLuminance(color) + 0.05);
}

function scaleColor(color: RgbColor, scale: number): RgbColor {
    return {
        red: Math.round(color.red * scale),
        green: Math.round(color.green * scale),
        blue: Math.round(color.blue * scale),
    };
}

export function whiteTextContrastRatio(color: string): number | null {
    const parsed = parseColor(color);
    return parsed ? contrastRatioWithWhite(parsed) : null;
}

export function ensureWhiteTextContrast(color: string): string {
    const parsed = scaleColor(parseColor(color) ?? FALLBACK_HEADER_COLOR, 1);
    if (contrastRatioWithWhite(parsed) >= MIN_WHITE_TEXT_CONTRAST) {
        return formatColor(parsed);
    }

    let passingScale = 0;
    let failingScale = 1;
    for (let iteration = 0; iteration < 16; iteration += 1) {
        const scale = (passingScale + failingScale) / 2;
        if (contrastRatioWithWhite(scaleColor(parsed, scale)) >= MIN_WHITE_TEXT_CONTRAST) {
            passingScale = scale;
        } else {
            failingScale = scale;
        }
    }
    return formatColor(scaleColor(parsed, passingScale));
}
