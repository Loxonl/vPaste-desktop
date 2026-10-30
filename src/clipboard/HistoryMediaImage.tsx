import { useLayoutEffect, useRef, type ImgHTMLAttributes } from "react";

/** The WebView loads the Rust file resource directly; JS never reads its body. */
export function HistoryMediaImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
    const imageRef = useRef<HTMLImageElement>(null);
    useLayoutEffect(() => {
        const image = imageRef.current;
        // StrictMode replays setup after cleanup without another React src commit.
        if (src) image?.setAttribute("src", src);
        else image?.removeAttribute("src");
        return () => { image?.removeAttribute("src"); };
    }, [src]);
    return <img {...props} ref={imageRef} src={src} data-history-media="true" />;
}
