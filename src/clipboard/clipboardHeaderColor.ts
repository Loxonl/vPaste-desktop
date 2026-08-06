export const WHITE_HEADER_TEXT_COLOR = "#fff";
// Preserve recognizable app colors; the header text shadow provides local edge separation.
export const MIN_WHITE_TEXT_CONTRAST = 1.4;

type RgbColor = {
    red: number;
    green: number;
    blue: number;
};

type ColorBucket = {
    red: number;
    green: number;
    blue: number;
    population: number;
    saturation: number;
    bucketRed: number;
    bucketGreen: number;
    bucketBlue: number;
};

const FALLBACK_HEADER_COLOR: RgbColor = { red: 86, green: 94, blue: 104 };
const MIN_DOMINANT_COLOR_SHARE = 0.05;
const MIN_DOMINANT_COLOR_SATURATION = 0.16;
const CLOSE_DOMINANT_COLOR_AREA_RATIO = 0.8;

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

export function dominantColorFromPixels(data: ArrayLike<number>): string | null {
    const buckets = new Map<string, ColorBucket>();
    let visibleWeight = 0;
    let colorWeight = 0;

    for (let index = 0; index + 3 < data.length; index += 4) {
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        const alpha = data[index + 3];
        if (alpha < 40) continue;

        const alphaWeight = alpha / 255;
        visibleWeight += alphaWeight;
        if (red > 245 && green > 245 && blue > 245) continue;
        if (red < 18 && green < 18 && blue < 18) continue;

        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        const saturation = max === 0 ? 0 : (max - min) / max;
        if (saturation < MIN_DOMINANT_COLOR_SATURATION) continue;

        colorWeight += alphaWeight;
        const bucketRed = Math.floor(red / 24);
        const bucketGreen = Math.floor(green / 24);
        const bucketBlue = Math.floor(blue / 24);
        const key = `${bucketRed},${bucketGreen},${bucketBlue}`;
        const bucket = buckets.get(key) ?? {
            red: 0,
            green: 0,
            blue: 0,
            population: 0,
            saturation: 0,
            bucketRed,
            bucketGreen,
            bucketBlue,
        };
        bucket.red += red * alphaWeight;
        bucket.green += green * alphaWeight;
        bucket.blue += blue * alphaWeight;
        bucket.population += alphaWeight;
        bucket.saturation += saturation * alphaWeight;
        buckets.set(key, bucket);
    }

    if (visibleWeight <= 0 || colorWeight / visibleWeight < MIN_DOMINANT_COLOR_SHARE) return null;
    const candidates = Array.from(buckets.values());
    const largestPopulation = Math.max(...candidates.map(candidate => candidate.population));
    if (largestPopulation <= 0) return null;

    const dominant = candidates
        .filter(candidate => candidate.population >= largestPopulation * CLOSE_DOMINANT_COLOR_AREA_RATIO)
        .sort((left, right) =>
            right.saturation / right.population - left.saturation / left.population
            || right.population - left.population
            || left.bucketRed - right.bucketRed
            || left.bucketGreen - right.bucketGreen
            || left.bucketBlue - right.bucketBlue,
        )[0];
    if (!dominant) return null;

    return formatColor({
        red: dominant.red / dominant.population,
        green: dominant.green / dominant.population,
        blue: dominant.blue / dominant.population,
    });
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
