import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const start = "<!-- vpaste-downloads:start -->";
const end = "<!-- vpaste-downloads:end -->";

function englishFirst(body) {
  const headings = [];
  let fence;
  for (const line of body.matchAll(/^.*$/gm)) {
    const marker = line[0].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (!fence) {
      const heading = line[0].match(/^## ([^\r\n]+)\r?$/);
      if (heading) headings.push({ title: heading[1].trim(), index: line.index });
    }
  }
  const english = headings.findIndex(heading => heading.title === "English");
  const chinese = headings.findIndex(heading => heading.title === "中文");
  if (english < 0 || chinese < 0 || english < chinese) return body;
  const sections = headings.map((heading, i) => body.slice(heading.index, headings[i + 1]?.index));
  [sections[chinese], sections[english]] = [sections[english], sections[chinese]];
  return body.slice(0, headings[0].index) + sections.map(section => section.trimEnd()).join("\n\n");
}

export function renderReleaseNotes(release, repo, tag, { requireUniversal = false } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(tag)) {
    throw new Error("Expected owner/repository and a stable or RC release tag");
  }
  const version = tag.slice(1);
  const assets = new Set(release.assets.filter(asset => asset.state === "uploaded").map(asset => asset.name));
  const rows = [
    ["Windows x64", "Installer / 安装版", "windows_x64_setup.exe"],
    ["Windows x64", "Portable / 免安装版", "windows_x64_portable.zip"],
    ["macOS Apple Silicon", "Apple M-series / M 系列芯片", "macos_aarch64.dmg"],
    ["macOS Intel", "Intel processors / Intel 芯片", "macos_x86_64.dmg"],
  ];
  if (requireUniversal || assets.has(`vPaste_${version}_macos_universal.dmg`)) {
    rows.push(["macOS Universal", "Both architectures / 两种芯片通用", "macos_universal.dmg"]);
  }
  const link = (label, name) => {
    if (!assets.has(name)) throw new Error(`Required download asset is missing or not uploaded: ${name}`);
    return `[${label}](https://github.com/${repo}/releases/download/${tag}/${name})`;
  };
  let body = release.body ?? "";
  if (body.includes(start) || body.includes(end)) {
    if (body.split(start).length !== 2 || body.split(end).length !== 2 || body.indexOf(end) < body.indexOf(start)) {
      throw new Error("Malformed download table markers; release notes were not changed");
    }
    body = `${body.slice(0, body.indexOf(start)).trimEnd()}\n\n${body.slice(body.indexOf(end) + end.length).trimStart()}`;
  }
  body = englishFirst(body);
  const table = rows.map(([platform, description, suffix]) =>
    `| ${platform} | ${description} | ${link("Download / 下载", `vPaste_${version}_${suffix}`)} |`,
  );
  const resources = [link("SHA-256 checksums / 校验", "SHA256SUMS.txt")];
  const metadata = `vPaste_${version}_release-metadata.zip`;
  if (assets.has(metadata)) resources.push(link("Release metadata / 许可证、签名与依赖资料", metadata));
  return [
    body.trimEnd(), "", start, "## Downloads / 下载", "",
    "| Platform / 系统 | Package / 版本 | Download / 下载 |",
    "| --- | --- | --- |", ...table, "", resources.join(" · "), "",
    "Choose a package above for manual installation; `.app.tar.gz` files are used by the in-app updater.",
    "普通安装请选择上表文件；`.app.tar.gz` 用于应用内自动更新。",
    end, "",
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tag = args[args.indexOf("--tag") + 1];
  const repo = args[args.indexOf("--repo") + 1];
  if (!args.includes("--tag") || !args.includes("--repo")) {
    throw new Error("Usage: update-release-downloads.mjs --repo owner/repo --tag vX.Y.Z [--require-universal] [--publish]");
  }
  const release = JSON.parse(execFileSync("gh", ["release", "view", tag, "--repo", repo, "--json", "body,assets"], { encoding: "utf8" }));
  const notes = renderReleaseNotes(release, repo, tag, { requireUniversal: args.includes("--require-universal") });
  if (args.includes("--publish")) {
    if (notes === release.body) {
      console.log("Release download table is already current.");
    } else {
      const directory = mkdtempSync(path.join(tmpdir(), "vpaste-release-notes-"));
      try {
        const notesFile = path.join(directory, "notes.md");
        writeFileSync(notesFile, notes, "utf8");
        execFileSync("gh", ["release", "edit", tag, "--repo", repo, "--notes-file", notesFile], { stdio: "inherit" });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } else {
    process.stdout.write(notes);
  }
}
