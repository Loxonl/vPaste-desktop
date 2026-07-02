export const NAME_PREFIX_EMOJIS = [
    "📝", "📄", "📋", "📌", "📁", "📂", "🗂️", "📦", "🔗", "🌐", "🎨", "🌈", "🖼️", "📷", "⭐", "❤️",
    "💬", "💡", "✅", "☑️", "⚠️", "🔒", "🔧", "⚙️", "🧩", "🔍", "📊", "📈", "📉", "🗒️", "📚", "📖",
    "✏️", "🖊️", "🗃️", "🧾", "🗓️", "⏰", "🚀", "🔥", "✨", "🎯", "🏷️", "🔖", "📎", "🧷", "🗝️", "🛠️",
    "💻", "⌨️", "🖥️", "📱", "🧠", "🧪", "🔬", "📐", "📏", "🧰", "🛡️", "🔔", "📣", "🎵", "🎬", "🎮",
    "🏠", "🏢", "💼", "💰", "🛒", "🎁", "☕", "🍀", "🌟", "🌙", "☀️", "⛅", "🌧️", "❄️", "🍎", "🍕",
    "😀", "😄", "😊", "😍", "🤔", "😎", "👍", "👎", "👏", "🙏", "🙌", "💪", "👀", "🎉", "🥳", "💯",
    "0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟", "#️⃣", "*️⃣", "🅰️", "🅱️", "🆕",
] as const;

const NAME_PREFIX_EMOJIS_BY_LENGTH = [...NAME_PREFIX_EMOJIS].sort((a, b) => b.length - a.length);

export function selectedNameEmoji(name: string): string {
    return NAME_PREFIX_EMOJIS_BY_LENGTH.find(emoji => name.startsWith(emoji)) || "";
}

export function stripNameEmojiPrefix(name: string): string {
    const emoji = selectedNameEmoji(name);
    if (!emoji) return name;
    return name.slice(emoji.length).replace(/^\s+/, "");
}

export function applyNameEmoji(name: string, emoji: string): string {
    const restName = stripNameEmojiPrefix(name);
    return emoji ? `${emoji}${restName ? ` ${restName}` : ""}` : restName;
}
