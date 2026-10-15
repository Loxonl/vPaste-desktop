import { describe, expect, it } from "vitest";
import { renderReleaseNotes } from "../../../scripts/update-release-downloads.mjs";

const repo = "Loxonl/vPaste-desktop";
const tag = "v1.6.1-rc.2";
const assets = [
  "windows_x64_setup.exe", "windows_x64_portable.zip",
  "macos_aarch64.dmg", "macos_x86_64.dmg", "macos_universal.dmg",
  "release-metadata.zip",
].map(suffix => ({ name: `vPaste_1.6.1-rc.2_${suffix}`, state: "uploaded" }));
assets.push({ name: "SHA256SUMS.txt", state: "uploaded" });

describe("release download table", () => {
  it("appends direct links after the complete existing release notes", () => {
    const body = "## English\nFixed an issue\n\n## 中文\n修复问题";
    const result = renderReleaseNotes({ body, assets }, repo, tag);
    expect(result.startsWith(`${body}\n\n<!-- vpaste-downloads:start -->`)).toBe(true);
    expect(result).toContain(`https://github.com/${repo}/releases/download/${tag}/vPaste_1.6.1-rc.2_windows_x64_setup.exe`);
    expect(result).toContain("Apple Silicon");
    expect(result).toContain("Universal");
    expect(result).toContain("SHA256SUMS.txt");
    expect(result).toContain("release-metadata.zip");
    expect(result.trimEnd().endsWith("<!-- vpaste-downloads:end -->")).toBe(true);
    expect(result).not.toContain(".app.tar.gz](");
    expect(result).toContain("## Downloads / 下载");
    expect(result).toContain("| Platform / 系统 | Package / 版本 | Download / 下载 |");
    expect(result).toContain("Installer / 安装版");
    expect(result.indexOf("Choose a package above")).toBeLessThan(result.indexOf("普通安装请选择"));
  });

  it("puts English before Chinese while preserving the title, subsections, and shared notes", () => {
    const title = "# vPaste 1.6.1-rc.2\n\n";
    const chinese = "## 中文\n\n### 修复\n- 修复问题\n\n";
    const english = "## English\n\n### Fixes\n- Fixed an issue\n\n";
    const shared = "## Packages / 安装包\nKeep the publisher warning\n\nSource: abc123";
    const result = renderReleaseNotes({ body: title + chinese + english + shared, assets }, repo, tag);
    expect(result.startsWith(title + english + chinese + shared)).toBe(true);
    expect(renderReleaseNotes({ body: result, assets }, repo, tag)).toBe(result);
  });

  it("preserves single-language and unstructured notes without inventing translations", () => {
    for (const body of ["## English\nExisting notes", "## 中文\n原有说明", "## What's Changed\n- Existing change"]) {
      expect(renderReleaseNotes({ body, assets }, repo, tag).startsWith(`${body}\n\n<!-- vpaste-downloads:start -->`)).toBe(true);
    }
  });

  it("keeps sections separated when the last language has no trailing newline", () => {
    const result = renderReleaseNotes({ body: "## 中文\n修复问题\n\n## English\nFixed an issue", assets }, repo, tag);
    expect(result).toContain("## English\nFixed an issue\n\n## 中文\n修复问题\n\n<!-- vpaste-downloads:start -->");
  });

  it("does not mistake fenced examples for release language headings", () => {
    const body = "## 中文\n示例：\n```markdown\n## English\nExample\n```\n\n## English\nActual updates";
    const result = renderReleaseNotes({ body, assets }, repo, tag);
    expect(result.startsWith("## English\nActual updates\n\n## 中文\n示例：\n```markdown\n## English\nExample\n```")).toBe(true);
  });

  it("is idempotent and moves the managed table below later handwritten notes", () => {
    const first = renderReleaseNotes({ body: "Notes", assets }, repo, tag);
    expect(renderReleaseNotes({ body: first, assets }, repo, tag)).toBe(first);
    const next = renderReleaseNotes({ body: `${first}\nLate note`, assets }, repo, tag);
    expect(next.indexOf("Late note")).toBeLessThan(next.indexOf("<!-- vpaste-downloads:start -->"));
    expect(next.match(/<!-- vpaste-downloads:start -->/g)).toHaveLength(1);
  });

  it("does not publish a broken table when a package is missing or still uploading", () => {
    expect(() => renderReleaseNotes({ body: "Notes", assets: assets.slice(1) }, repo, tag)).toThrow(/missing/i);
    expect(() => renderReleaseNotes({ body: "Notes", assets: assets.map((asset, i) => i ? asset : { ...asset, state: "new" }) }, repo, tag)).toThrow(/missing/i);
  });

  it("supports older releases without linking a nonexistent metadata archive", () => {
    const result = renderReleaseNotes({ body: "Old notes", assets: assets.filter(asset => !asset.name.endsWith("release-metadata.zip")) }, repo, tag);
    expect(result).not.toContain("release-metadata.zip");
    expect(result).toContain("SHA256SUMS.txt");
  });

  it("omits the Universal package on older releases but requires it for new releases", () => {
    const release = { body: "Old notes", assets: assets.filter(asset => !asset.name.endsWith("macos_universal.dmg")) };
    const result = renderReleaseNotes(release, repo, tag);
    expect(result).not.toContain("macos_universal.dmg");
    expect(result).toContain("macos_aarch64.dmg");
    expect(result).toContain("macos_x86_64.dmg");
    expect(() => renderReleaseNotes(release, repo, tag, { requireUniversal: true })).toThrow(/macos_universal/);
  });

  it("rejects malformed markers instead of discarding user text", () => {
    expect(() => renderReleaseNotes({ body: "Notes\n<!-- vpaste-downloads:start -->\nText", assets }, repo, tag)).toThrow(/marker/i);
  });
});
