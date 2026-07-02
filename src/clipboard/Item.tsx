import { Avatar, CardContent, CardMedia, Grid } from "@mui/material";
import Card from "@mui/material/Card";
import { MouseEventHandler, useEffect, useRef, useState } from "react";
import Typography from "@mui/material/Typography";
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { convertFileSrc } from "@tauri-apps/api/core";
import './Item.css'
import { info } from "@tauri-apps/plugin-log";

class ItemProp {
    public readonly selected: boolean;
    public readonly item: Item;
    public onClick: MouseEventHandler;

    constructor(selected: boolean, item: Item, onClick: MouseEventHandler) {
        this.selected = selected;
        this.item = item;
        this.onClick = onClick;
    }
}

function genTextContent(item: Item) {
    return item.getContent();
}

function genImageContent(item: Item) {
    const assetUrl = convertFileSrc(item.getContent());
    info(`${JSON.stringify(item)} ${assetUrl}`)
    const imageRef = useRef<HTMLImageElement>(null);
    const [width, setWidth] = useState<String>("auto")
    const [height, setHeight] = useState<String>("auto")
    useEffect(() => {
        let width = imageRef.current?.naturalWidth;
        let height = imageRef.current?.naturalHeight;
        if (width == undefined || height == undefined) {
            return
        }
        if (width <= 100 && height <= 100) {
            if (width > height) {
                setWidth(`150px`)
                setHeight(`auto`)
            } else {
                setWidth(`auto`)
                setHeight(`150px`)
            }

            return
        }
        if (width <= 280 && height <= 218) {
            setWidth(`${width}px`)
            setHeight(`${height}px`)
            return;
        }
        if (width > height) {
            setWidth(`100%`)
            setHeight(`auto`)
            return
        } else {
            setWidth(`auto`)
            setHeight(`100%`)
            return
        }
    }, [imageRef.current?.naturalWidth, imageRef.current?.naturalHeight])
    return <div className='image-container'
    >
        <label className="image-size">{imageRef.current?.naturalWidth} x {imageRef.current?.naturalHeight}</label>
        <CardMedia
            ref={imageRef}
            component="img"
            sx={{ width: width.concat(), height: height.concat() }}
            image={assetUrl}
        />
    </div>;
}

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


function getContent(item: Item) {


    switch (item.getType()) {
        case ItemType.TextFile:
        case ItemType.Text:
            return <CardContent>{genTextContent(item)}</CardContent>;
        case ItemType.Color:
            return <CardContent sx={{
                backgroundColor: item.getContent(),
                height: "100%",
                justifyContent: "center",
                alignItems: "center"
            }}>{item.getContent()}</CardContent>
        case ItemType.Image:
            return genImageContent(item);
        default:
            return <CardContent>{item.getContent()}</CardContent>;
    }
}

function getTitle(item: Item) {
    switch (item.getType()) {
        case ItemType.TextFile:
        case ItemType.Text:
            return "文本";
        case ItemType.Link:
            return "链接";
        case ItemType.Color:
            return "颜色";
        case ItemType.Image:
            return "图片";
        case ItemType.File:
            return "文件";
        default:
            return item.getContent();
    }
}

export function formatTimeDifference(timestamp: number): string {
    const now = new Date();
    const gmtTimestamp = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        now.getUTCMinutes(),
        now.getUTCSeconds(),
        now.getUTCMilliseconds()
    );

    const diff = gmtTimestamp - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (seconds < 10) {
        return `刚刚`;
    } else if (seconds < 60) {
        return `${seconds}秒前`;
    } else if (minutes < 60) {
        return `${minutes}分钟前`;
    } else if (hours < 24) {
        return `${hours}小时前`;
    } else if (days < 30) {
        return `${days}天前`;
    } else if (months < 12) {
        return `${months}个月前`;
    } else {
        return `${years}年前`;
    }
}


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

    element(props: any) {
        const titleBackgroundColor = this.getTitleColor() || "#0078D4";
        console.log(this.hash)
        return <Grid
            onClick={props.onClick}
            component="div"
            container spacing={0} sx={{
                width: 270,
                height: 277,
                overflow: 'hidden',
                outlineStyle: props.selected ? "solid" : "none",
                outlineColor: '#0078D4',
                outlineOffset: -1,
                outlineWidth: 7,
                borderRadius: "16px 16px 16px 16px"
            }}>
            <Grid xs={1} height={60} sx={{ backgroundColor: titleBackgroundColor }}>

            </Grid>
            <Grid xs={7} sx={{ backgroundColor: titleBackgroundColor, color: "#FFFFFF" }}>
                <Typography variant="subtitle1" sx={{ height: 20, paddingTop: 0.5 }} gutterBottom>
                    {getTitle(this)}
                </Typography>
                <Typography variant="body2" sx={{ height: 20 }}>
                    {formatTimeDifference(this.time)}
                </Typography>
            </Grid>
            <Grid xs={4} sx={{ backgroundColor: titleBackgroundColor }} justifyContent="flex-end" display="flex">
                <Avatar sx={{
                    bgcolor: titleBackgroundColor,
                    height: '100%',
                    width: 60,
                    aspectRatio: "1/1",
                    borderRadius: "0px 16px 0px 0px",
                    boxShadow: "-3px 0 5px 0 rgba(0, 0, 0, 0.25);"
                }} variant="square">
                    <ContentCopyIcon />
                </Avatar>
            </Grid>
            <Grid xs={12}>
                <Card sx={{
                    height: 220, width: "100%",
                    background: "rgba(255,255,255,0.8)",
                    border: 'none',
                }}>


                    {getContent(this)}
                </Card>
            </Grid>

        </Grid>
    }

}

export const ClipboardItem = function (props: ItemProp) {
    return props.item.element(props);
}
