export type LanguageCode = string;

export type LanguagePack = {
    code: LanguageCode;
    name: string;
    nativeName: string;
    translations: Record<string, string>;
};

