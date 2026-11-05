(() => {
    const send = url => { window.top.location.href = url; };
    window.addEventListener("keydown", event => {
        if (!event.isTrusted || event.isComposing || event.altKey || event.metaKey) return;
        const key = event.key === " " || event.key === "Spacebar" ? "Space" : event.key;
        if (!["Escape", "Space", "ArrowLeft", "ArrowRight", "Tab"].includes(key)) return;
        const editing = event.composedPath().some(node => node instanceof Element
            && (node.matches("input,textarea,select") || node.isContentEditable));
        if (editing && key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat && (key === "Space" || key === "Escape")) return;
        send(`https://keyboard.vpaste.invalid/__TOKEN__/${key}/${event.ctrlKey ? 1 : 0}/${event.shiftKey ? 1 : 0}`);
    }, true);
})();
