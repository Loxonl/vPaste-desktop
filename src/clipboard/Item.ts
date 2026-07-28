export enum ItemType {
    Text = "Text",
    TextFile = "TextFile",
    Color = "Color",
    Image = "Image",
    Link = "Link",
    File = "File"
}

export type ItemTag = {
    id: number;
    name: string;
};

export class Item {
    private readonly id: number;
    private readonly hash: string;
    private readonly type: ItemType;
    private readonly titleColor?: string;
    private readonly content: string;
    private readonly previewContent: string;
    private readonly textContent: string;
    private readonly richHtml: string;
    private readonly appSource: string;
    private readonly appIconPath: string;
    private readonly time: number;
    private readonly label: number;
    private readonly tags: ItemTag[];

    constructor(id: number, hash: string, type: ItemType, content: string, time: number, titleColor?: string, previewContent: string = "", textContent: string = "", label: number = 0, appSource: string = "", appIconPath: string = "", richHtml: string = "", tags: ItemTag[] = []) {
        this.id = id;
        this.hash = hash;
        this.type = type;
        this.content = content;
        this.previewContent = previewContent;
        this.textContent = textContent;
        this.richHtml = richHtml;
        this.appSource = appSource;
        this.appIconPath = appIconPath;
        this.time = time;
        this.titleColor = titleColor;
        this.label = label;
        this.tags = tags;
    }

    getTitleColor() {
        return this.titleColor;
    }

    getId() {
        return this.id;
    }

    getTime() {
        return this.time;
    }

    getHash() {
        return this.hash;
    }

    getType() {
        return this.type;
    }

    getContent() {
        return this.content;
    }

    getPreviewContent() {
        return this.previewContent || this.content;
    }

    getTextContent() {
        return this.textContent;
    }

    getRichHtml() {
        return this.richHtml;
    }

    isRichText() {
        return this.richHtml.trim().length > 0;
    }

    getAppSource() {
        return this.appSource;
    }

    getAppIconPath() {
        return this.appIconPath;
    }

    getLabel() {
        return this.label;
    }

    isFavorite() {
        return this.label === 1;
    }

    getTags() {
        return this.tags;
    }

    withTags(tags: ItemTag[]) {
        return new Item(
            this.id,
            this.hash,
            this.type,
            this.content,
            this.time,
            this.titleColor,
            this.previewContent,
            this.textContent,
            this.label,
            this.appSource,
            this.appIconPath,
            this.richHtml,
            tags,
        );
    }
}
