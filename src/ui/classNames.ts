export type ClassValue = string | false | null | undefined;

export function classes(
    styles: Record<string, string>,
    ...values: ClassValue[]
): string {
    return values
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .flatMap(value => value.split(/\s+/))
        .filter(Boolean)
        .map(name => styles[name] || name)
        .join(" ");
}
