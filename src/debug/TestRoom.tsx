import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import MoreHorizRoundedIcon from "@mui/icons-material/MoreHorizRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import InputAdornment from "@mui/material/InputAdornment";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import {
    APP_SOURCE_OPTIONS,
    BUILT_IN_SAMPLE_GROUPS,
    createDefaultTestRoomConfig,
    isDirectlyEditableSampleType,
    MAX_SAMPLE_TIME_OFFSET_MS,
    mergeTestRoomConfig,
    presetOptionsFor,
    sampleValueFromPreset,
    sampleTimeOffsetMs,
    type SampleGroup,
    type SampleItem,
    type SampleItemType,
    type TestRoomConfig,
} from "./testRoomModel";
import styles from "./TestRoom.module.css";

type OperationResult = { affectedItems: number; message: string };
type CaseResult = { passed: boolean; message: string; durationMs: number };
type CaseState = CaseResult & { status: "passed" | "failed" };

const CASE_GROUPS = [
    {
        id: "text",
        name: "文本与富文本",
        cases: [
            { id: "clipboard-text", code: "TC-TEXT-01", name: "纯文本写入与读回", description: "验证文本内容与类型。" },
            { id: "clipboard-rich-text", code: "TC-TEXT-02", name: "富文本写入与读回", description: "验证摘要与 HTML。" },
        ],
    },
    {
        id: "excel",
        name: "Excel 与表格",
        cases: [
            { id: "excel-chart", code: "TC-EXCEL-01", name: "Excel 图表与表格", description: "验证表格与内嵌图表。" },
        ],
    },
    {
        id: "image",
        name: "图片",
        cases: [
            { id: "clipboard-image", code: "TC-IMAGE-01", name: "图片写入与读回", description: "验证图片存储与类型。" },
            { id: "qq-two-images", code: "TC-IMAGE-02", name: "QQ 双图消息", description: "验证单条消息包含两张图片。" },
            { id: "gif-history", code: "TC-IMAGE-03", name: "GIF 历史预览", description: "验证 GIF 写入与识别。" },
            { id: "image-fixtures", code: "TC-IMAGE-04", name: "透明 PNG 解码", description: "验证透明通道。" },
        ],
    },
    {
        id: "link",
        name: "链接",
        cases: [
            { id: "clipboard-link", code: "TC-LINK-01", name: "链接写入与分类", description: "验证 URL 与分类。" },
        ],
    },
    {
        id: "file",
        name: "文件",
        cases: [
            { id: "file-single-types", code: "TC-FILE-01", name: "TXT、PNG、PSD 单文件", description: "依次写入三个单文件项。" },
            { id: "file-multiple", code: "TC-FILE-02", name: "TXT、PNG、PSD 多文件", description: "三个文件合为一个粘贴项。" },
            { id: "file-folder", code: "TC-FILE-03", name: "单文件夹", description: "写入一个文件夹项。" },
            { id: "file-folder-and-file", code: "TC-FILE-04", name: "文件夹与文件", description: "文件夹和文件合为一项。" },
            { id: "file-missing", code: "TC-FILE-05", name: "已删除文件", description: "验证失效文件状态。" },
        ],
    },
    {
        id: "color",
        name: "颜色",
        cases: [
            { id: "clipboard-color", code: "TC-COLOR-01", name: "颜色写入与分类", description: "验证色值与分类。" },
        ],
    },
    {
        id: "boundary",
        name: "边界测试",
        cases: [
            { id: "boundary-long-text", code: "TC-BOUNDARY-01", name: "超长文本", description: "验证主面板显示受控摘要，粘贴仍保留完整内容。" },
            { id: "boundary-large-image", code: "TC-BOUNDARY-02", name: "超大图片", description: "验证超过自动预览预算后稳定降级。" },
            { id: "boundary-large-gif", code: "TC-BOUNDARY-03", name: "大型 GIF", description: "验证超过自动播放预算后显示静态预览。" },
        ],
    },
    {
        id: "window",
        name: "主窗口生命周期",
        cases: [
            { id: "main-window-cycle", code: "TC-WINDOW-01", name: "隐藏与连续重开", description: "验证连续隐藏与重开。" },
        ],
    },
    {
        id: "function",
        name: "功能与元数据",
        cases: [
            { id: "time-sequence", code: "TC-FUNCTION-01", name: "最近时间序列", description: "验证组内连续时间。" },
            { id: "metadata-roundtrip", code: "TC-FUNCTION-02", name: "分类与来源 App", description: "验证分类与来源元数据。" },
            { id: "sample-config", code: "TC-FUNCTION-03", name: "样板配置读取", description: "验证持久化配置。" },
            { id: "developer-gate", code: "TC-FUNCTION-04", name: "Debug 双重门禁", description: "验证开发模式门禁。" },
        ],
    },
] as const;

const ITEM_TYPES: SampleItemType[] = ["Text", "RichText", "Excel", "Color", "Link", "Image", "File", "TextFile"];

function uniqueId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneBuiltIn(group: SampleGroup): SampleGroup {
    return { ...group, items: group.items.map(item => ({ ...item })) };
}

function sampleItemLabel(item: SampleItem) {
    return item.name.trim() || `${item.itemType} 样板`;
}

export default function TestRoom() {
    const [tab, setTab] = useState(0);
    const [config, setConfig] = useState<TestRoomConfig | null>(null);
    const configRef = useRef<TestRoomConfig | null>(null);
    const saveQueue = useRef(Promise.resolve());
    const [selectedGroupId, setSelectedGroupId] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const [caseStates, setCaseStates] = useState<Record<string, CaseState>>({});
    const [runningCaseId, setRunningCaseId] = useState("");
    const [groupMenuAnchor, setGroupMenuAnchor] = useState<HTMLElement | null>(null);
    const [groupMenuId, setGroupMenuId] = useState("");

    useEffect(() => {
        void invoke<TestRoomConfig | null>("get_test_room_config")
            .then(stored => {
                const merged = mergeTestRoomConfig(stored);
                configRef.current = merged;
                setConfig(merged);
                setSelectedGroupId(merged.groups[0]?.id ?? "");
                if (JSON.stringify(stored) !== JSON.stringify(merged)) {
                    return invoke("save_test_room_config", { config: merged });
                }
            })
            .catch(reason => setError(String(reason)));
    }, []);

    const selectedGroup = useMemo(
        () => config?.groups.find(group => group.id === selectedGroupId) ?? null,
        [config, selectedGroupId],
    );

    const persist = (next: TestRoomConfig) => {
        saveQueue.current = saveQueue.current
            .catch(() => undefined)
            .then(() => invoke("save_test_room_config", { config: next }).then(() => undefined))
            .catch(reason => setError(String(reason)));
    };

    const updateConfig = (updater: (current: TestRoomConfig) => TestRoomConfig, save = true) => {
        const current = configRef.current;
        if (!current) return;
        const next = updater(current);
        configRef.current = next;
        setConfig(next);
        if (save) persist(next);
    };

    const saveCurrentDraft = () => {
        if (configRef.current) persist(configRef.current);
    };

    const updateGroup = (groupId: string, updater: (group: SampleGroup) => SampleGroup, save = true) => {
        updateConfig(current => ({
            ...current,
            groups: current.groups.map(group => group.id === groupId ? updater(group) : group),
        }), save);
    };

    const updateItem = (
        groupId: string,
        itemId: string,
        updater: (item: SampleItem) => SampleItem,
        save = true,
    ) => updateGroup(groupId, group => ({
        ...group,
        items: group.items.map(item => item.id === itemId ? updater(item) : item),
    }), save);

    const runCases = async (caseIds: string[]) => {
        if (busy) return;
        setBusy(true);
        setError("");
        for (const caseId of caseIds) {
            setRunningCaseId(caseId);
            try {
                const result = await invoke<CaseResult>("run_test_room_case", { caseId });
                setCaseStates(current => ({
                    ...current,
                    [caseId]: { ...result, status: result.passed ? "passed" : "failed" },
                }));
            } catch (reason) {
                setCaseStates(current => ({
                    ...current,
                    [caseId]: { passed: false, message: String(reason), durationMs: 0, status: "failed" },
                }));
            }
        }
        setRunningCaseId("");
        setBusy(false);
    };

    const operate = async (operation: () => Promise<OperationResult>) => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            const result = await operation();
            setNotice(result.message);
        } catch (reason) {
            setError(String(reason));
        } finally {
            setBusy(false);
        }
    };

    const addGroup = () => {
        const id = uniqueId("group");
        const group: SampleGroup = {
            id,
            name: "新样板组",
            builtIn: false,
            items: [{
                id: uniqueId("item"),
                name: "新文本",
                itemType: "Text",
                value: "可安全展示的样板内容",
                appSource: "",
                timeOffsetMs: 0,
            }],
        };
        updateConfig(current => ({ ...current, groups: [...current.groups, group] }));
        setSelectedGroupId(id);
    };

    const copyGroup = (source: SampleGroup) => {
        const id = uniqueId("group");
        const copied: SampleGroup = {
            ...source,
            id,
            name: `${source.name} 副本`,
            builtIn: false,
            items: source.items.map(item => ({ ...item, id: uniqueId("item") })),
        };
        updateConfig(current => ({ ...current, groups: [...current.groups, copied] }));
        setSelectedGroupId(id);
    };

    const deleteGroup = (groupToDelete: SampleGroup) => {
        if (!window.confirm(`确认删除分组“${groupToDelete.name}”吗？已写入的该组样板也会被清理。`)) return;
        const removedId = groupToDelete.id;
        updateConfig(current => ({
            ...current,
            groups: current.groups.filter(group => group.id !== removedId),
            deletedBuiltInGroupIds: groupToDelete.builtIn
                ? [...new Set([...current.deletedBuiltInGroupIds, removedId])]
                : current.deletedBuiltInGroupIds,
        }));
        if (selectedGroupId === removedId) {
            const nextGroup = configRef.current?.groups[0];
            setSelectedGroupId(nextGroup?.id ?? "");
        }
        void operate(() => invoke("cleanup_test_room_groups", { groupIds: [removedId] }));
    };

    const restoreBuiltIns = () => {
        if (!window.confirm("确认恢复内置中文与英文样板吗？内置组的本地修改会被重置，自建组会保留。")) return;
        const builtInIds = BUILT_IN_SAMPLE_GROUPS.map(group => group.id);
        if (!configRef.current) {
            const restored = createDefaultTestRoomConfig();
            configRef.current = restored;
            setConfig(restored);
            setSelectedGroupId(restored.groups[0]?.id ?? "");
            setError("");
            persist(restored);
            return;
        }
        updateConfig(current => ({
            ...current,
            groups: [
                ...BUILT_IN_SAMPLE_GROUPS.map(cloneBuiltIn),
                ...current.groups.filter(group => !builtInIds.includes(group.id)),
            ],
            deletedBuiltInGroupIds: current.deletedBuiltInGroupIds.filter(id => !builtInIds.includes(id)),
            deletedBuiltInItemIds: current.deletedBuiltInItemIds.filter(id => !BUILT_IN_SAMPLE_GROUPS.some(
                group => group.items.some(item => item.id === id),
            )),
        }));
        setSelectedGroupId(BUILT_IN_SAMPLE_GROUPS[0].id);
        void operate(() => invoke("cleanup_test_room_groups", { groupIds: builtInIds }));
    };

    const addItem = () => {
        if (!selectedGroup) return;
        updateGroup(selectedGroup.id, group => ({
            ...group,
            items: [...group.items, {
                id: uniqueId("item"),
                name: "新文本",
                itemType: "Text",
                value: "可安全展示的样板内容",
                appSource: "",
                timeOffsetMs: sampleTimeOffsetMs(group.items.length),
            }],
        }));
    };

    const moveItem = (index: number, direction: -1 | 1) => {
        if (!selectedGroup) return;
        const target = index + direction;
        if (target < 0 || target >= selectedGroup.items.length) return;
        updateGroup(selectedGroup.id, group => {
            const items = [...group.items];
            [items[index], items[target]] = [items[target], items[index]];
            return { ...group, items };
        });
    };

    const allCaseIds = CASE_GROUPS.flatMap(group => group.cases.map(testCase => testCase.id));

    return (
        <main className={styles.page} data-testid="test-room">
            <div className={styles.topBar}>
                <Tabs
                    className={styles.tabs}
                    value={tab}
                    onChange={(_, value: number) => setTab(value)}
                    aria-label="测试间功能"
                    sx={{
                        "& .MuiTabs-scroller": { width: "auto" },
                        "& .MuiTabs-flexContainer": { display: "inline-flex" },
                        "& .MuiTab-root": {
                            minWidth: 96,
                            minHeight: 38,
                            width: "auto",
                            maxWidth: "none",
                            px: "14px",
                            py: "7px",
                            justifyContent: "center",
                        },
                    }}
                >
                    <Tab label="测试用例" />
                    <Tab label="写入样板" />
                </Tabs>
                <Button
                    color="error"
                    variant="outlined"
                    startIcon={<DeleteOutlineRoundedIcon />}
                    disabled={busy}
                    sx={{ minHeight: 40, flex: "0 0 auto" }}
                    onClick={() => window.confirm("确认清理全部写入样板历史和今天由测试用例生成的历史吗？真实历史和更早的测试用例历史不会被删除。")
                        && void operate(() => invoke("cleanup_test_room_history"))}
                >清理测试历史</Button>
            </div>

            {(error || notice) && (
                <div className={error ? styles.errorNotice : styles.notice} role={error ? "alert" : "status"}>
                    {error || notice}
                    <button type="button" onClick={() => { setError(""); setNotice(""); }}>关闭</button>
                </div>
            )}

            {tab === 0 && (
                <section className={styles.casePage} aria-label="测试用例">
                    <div className={styles.pageActions}>
                        <div className={styles.primaryActions}>
                            <Button
                                variant="contained"
                                startIcon={busy ? <CircularProgress color="inherit" size={15} /> : <PlayArrowRoundedIcon />}
                                disabled={busy}
                                sx={{ minHeight: 40 }}
                                onClick={() => void runCases(allCaseIds)}
                            >
                                全部运行
                            </Button>
                        </div>
                        <span>测试记录会保留，按需手动清理。</span>
                    </div>
                    {CASE_GROUPS.map(group => (
                        <article className={styles.caseGroup} key={group.id}>
                            <div className={styles.groupHeading}>
                                <div><h2>{group.name}</h2><span>{group.cases.length} 个用例</span></div>
                                <Button
                                    size="small"
                                    variant="outlined"
                                    disabled={busy}
                                    onClick={() => void runCases(group.cases.map(testCase => testCase.id))}
                                >分组运行</Button>
                            </div>
                            <div className={styles.caseList}>
                                {group.cases.map(testCase => {
                                    const state = caseStates[testCase.id];
                                    const running = runningCaseId === testCase.id;
                                    return (
                                        <div className={styles.caseRow} key={testCase.id}>
                                            <div>
                                                <strong><span className={styles.caseCode}>{testCase.code}</span> · {testCase.name}</strong>
                                                <p>{testCase.description}</p>
                                                {state && <small className={state.passed ? styles.passed : styles.failed}>{state.message} · {state.durationMs}ms</small>}
                                            </div>
                                            <Button
                                                size="small"
                                                disabled={busy}
                                                sx={{ minWidth: 76, minHeight: 40 }}
                                                startIcon={running ? <CircularProgress size={14} /> : <PlayArrowRoundedIcon />}
                                                onClick={() => void runCases([testCase.id])}
                                            >运行</Button>
                                        </div>
                                    );
                                })}
                            </div>
                        </article>
                    ))}
                </section>
            )}

            {tab === 1 && (
                <section className={styles.samplesPage} aria-label="写入样板">
                    <aside className={styles.sidebar}>
                        <div className={styles.sidebarHeading}>
                            <strong>样板分组</strong>
                            <button type="button" title="新建分组" aria-label="新建分组" onClick={addGroup}><AddRoundedIcon /></button>
                        </div>
                        <div className={styles.groupList}>
                            {config?.groups.map(group => (
                                <div className={styles.groupListItem} key={group.id}>
                                    <button
                                        type="button"
                                        className={group.id === selectedGroupId ? styles.selectedGroup : ""}
                                        onClick={() => setSelectedGroupId(group.id)}
                                    >
                                        <span>{group.name}</span>
                                        <small>{group.items.length}</small>
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.groupMenuButton}
                                        aria-label={`管理分组 ${group.name}`}
                                        onClick={event => {
                                            setGroupMenuAnchor(event.currentTarget);
                                            setGroupMenuId(group.id);
                                        }}
                                    ><MoreHorizRoundedIcon /></button>
                                </div>
                            ))}
                        </div>
                        <Menu
                            anchorEl={groupMenuAnchor}
                            open={Boolean(groupMenuAnchor)}
                            onClose={() => setGroupMenuAnchor(null)}
                        >
                            <MenuItem onClick={() => {
                                const group = config?.groups.find(candidate => candidate.id === groupMenuId);
                                setGroupMenuAnchor(null);
                                if (group) copyGroup(group);
                            }} sx={{ gap: "var(--ui-space-2)" }}><ContentCopyRoundedIcon fontSize="small" />复制分组</MenuItem>
                            <MenuItem className={styles.dangerMenuItem} onClick={() => {
                                const group = config?.groups.find(candidate => candidate.id === groupMenuId);
                                setGroupMenuAnchor(null);
                                if (group) deleteGroup(group);
                            }} sx={{ gap: "var(--ui-space-2)" }}><DeleteOutlineRoundedIcon fontSize="small" />删除分组</MenuItem>
                        </Menu>
                        <Button size="small" startIcon={<RestartAltRoundedIcon />} onClick={restoreBuiltIns}>恢复内置样板</Button>
                    </aside>

                    <div className={styles.editor}>
                        {!config && !error && <CircularProgress />}
                        {config && !selectedGroup && <p className={styles.empty}>新建一个样板分组开始编辑。</p>}
                        {selectedGroup && (
                            <>
                                <div className={styles.editorHeading}>
                                    <TextField
                                        size="small"
                                        label="分组名称"
                                        value={selectedGroup.name}
                                        onChange={event => updateGroup(selectedGroup.id, group => ({ ...group, name: event.target.value }), false)}
                                        onBlur={saveCurrentDraft}
                                    />
                                    <Button
                                        variant="contained"
                                        disabled={busy || selectedGroup.items.length === 0}
                                        sx={{ minHeight: 40, flex: "0 0 auto" }}
                                        onClick={() => void operate(() => invoke("write_test_room_groups", { groups: [selectedGroup] }))}
                                    >写入当前组</Button>
                                </div>

                                <div className={styles.itemList}>
                                    {selectedGroup.items.map((item, index) => {
                                        const presets = presetOptionsFor(item.itemType);
                                        const itemLabel = sampleItemLabel(item);
                                        return (
                                            <article className={styles.itemCard} key={item.id}>
                                                <div className={styles.itemOrder}>
                                                    <span>{index + 1}</span>
                                                    <small>距现在</small>
                                                    <TextField
                                                        className={styles.timeInput}
                                                        size="small"
                                                        type="number"
                                                        value={(item.timeOffsetMs ?? sampleTimeOffsetMs(index)) / 1_000}
                                                        onFocus={event => event.target.select()}
                                                        onChange={event => {
                                                            const seconds = Number(event.target.value);
                                                            if (!Number.isFinite(seconds)
                                                                || seconds < 0
                                                                || seconds * 1_000 > MAX_SAMPLE_TIME_OFFSET_MS) {
                                                                setError("样板时间需要填写 0–300 秒");
                                                                return;
                                                            }
                                                            setError("");
                                                            updateItem(selectedGroup.id, item.id, current => ({
                                                                ...current,
                                                                timeOffsetMs: Math.round(seconds * 1_000),
                                                            }), false);
                                                        }}
                                                        onBlur={saveCurrentDraft}
                                                        inputProps={{
                                                            min: 0,
                                                            max: MAX_SAMPLE_TIME_OFFSET_MS / 1_000,
                                                            step: 1,
                                                            "aria-label": `距现在 ${itemLabel}（秒）`,
                                                        }}
                                                        InputProps={{
                                                            endAdornment: <InputAdornment position="end">秒</InputAdornment>,
                                                        }}
                                                    />
                                                    <button type="button" aria-label={`上移 ${itemLabel}`} disabled={index === 0} onClick={() => moveItem(index, -1)}><ArrowUpwardRoundedIcon /></button>
                                                    <button type="button" aria-label={`下移 ${itemLabel}`} disabled={index === selectedGroup.items.length - 1} onClick={() => moveItem(index, 1)}><ArrowDownwardRoundedIcon /></button>
                                                </div>
                                                <div className={styles.itemFields}>
                                                    <TextField
                                                        size="small"
                                                        label="名称（可留空）"
                                                        value={item.name}
                                                        onChange={event => updateItem(selectedGroup.id, item.id, current => ({ ...current, name: event.target.value }), false)}
                                                        onBlur={saveCurrentDraft}
                                                    />
                                                    <Select
                                                        size="small"
                                                        value={item.itemType}
                                                        aria-label="粘贴项类型"
                                                        onChange={event => {
                                                            const itemType = event.target.value as SampleItemType;
                                                            const preset = presetOptionsFor(itemType)[0];
                                                            updateItem(selectedGroup.id, item.id, current => ({
                                                                ...current,
                                                                itemType,
                                                                presetId: preset?.id ?? "",
                                                                value: itemType === "Text"
                                                                    ? "可安全展示的样板内容"
                                                                    : preset ? sampleValueFromPreset(itemType, preset) : "",
                                                            }));
                                                        }}
                                                    >
                                                        {ITEM_TYPES.map(type => <MenuItem value={type} key={type}>{type}</MenuItem>)}
                                                    </Select>
                                                    <Select
                                                        size="small"
                                                        value={item.appSource}
                                                        displayEmpty
                                                        aria-label="来源 App"
                                                        onChange={event => updateItem(selectedGroup.id, item.id, current => ({ ...current, appSource: event.target.value }))}
                                                    >
                                                        {APP_SOURCE_OPTIONS.map(source => <MenuItem value={source} key={source || "none"}>{source || "无来源 App"}</MenuItem>)}
                                                    </Select>
                                                    {item.itemType === "Text" ? (
                                                        <TextField
                                                            className={styles.contentField}
                                                            size="small"
                                                            multiline
                                                            minRows={2}
                                                            label="文字内容"
                                                            value={item.value}
                                                            onChange={event => updateItem(selectedGroup.id, item.id, current => ({ ...current, value: event.target.value }), false)}
                                                            onBlur={saveCurrentDraft}
                                                        />
                                                    ) : (
                                                        <div className={styles.contentControls}>
                                                            <Select
                                                                size="small"
                                                                value={item.presetId ?? ""}
                                                                displayEmpty
                                                                aria-label={`选择 ${itemLabel} 内容预设`}
                                                                onChange={event => {
                                                                    if (!event.target.value) {
                                                                        updateItem(selectedGroup.id, item.id, current => ({
                                                                            ...current,
                                                                            presetId: "",
                                                                        }));
                                                                        return;
                                                                    }
                                                                    const preset = presets.find(candidate => candidate.id === event.target.value);
                                                                    if (!preset) return;
                                                                    updateItem(selectedGroup.id, item.id, current => ({
                                                                        ...current,
                                                                        presetId: preset.id,
                                                                        value: sampleValueFromPreset(current.itemType, preset),
                                                                    }));
                                                                }}
                                                            >
                                                                {isDirectlyEditableSampleType(item.itemType)
                                                                    && <MenuItem value="">自定义内容</MenuItem>}
                                                                {presets.map(preset => <MenuItem value={preset.id} key={preset.id}>{preset.label}</MenuItem>)}
                                                            </Select>
                                                            {isDirectlyEditableSampleType(item.itemType) && (
                                                                <TextField
                                                                    size="small"
                                                                    multiline={item.itemType === "RichText" || item.itemType === "Excel" || item.itemType === "TextFile"}
                                                                    minRows={item.itemType === "Excel" ? 4 : 2}
                                                                    label={item.itemType === "Excel" ? "表格内容（Tab 分列）" : "可编辑内容"}
                                                                    inputProps={{ "aria-label": `编辑 ${itemLabel} 内容` }}
                                                                    value={item.value}
                                                                    onChange={event => updateItem(selectedGroup.id, item.id, current => ({
                                                                        ...current,
                                                                        presetId: "",
                                                                        value: event.target.value,
                                                                    }), false)}
                                                                    onBlur={saveCurrentDraft}
                                                                />
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                                <div className={styles.itemActions}>
                                                    <button
                                                        type="button"
                                                        aria-label={`写入剪贴板 ${itemLabel}`}
                                                        title="写入当前剪贴板"
                                                        disabled={busy}
                                                        onClick={() => void operate(() => invoke("copy_test_room_item_to_clipboard", { item }))}
                                                    ><ContentCopyRoundedIcon /></button>
                                                    <button
                                                        type="button"
                                                        aria-label={`删除 ${itemLabel}`}
                                                        onClick={() => updateConfig(current => ({
                                                            ...current,
                                                            groups: current.groups.map(group => group.id === selectedGroup.id
                                                                ? { ...group, items: group.items.filter(candidate => candidate.id !== item.id) }
                                                                : group),
                                                            deletedBuiltInItemIds: BUILT_IN_SAMPLE_GROUPS.some(group => group.items.some(candidate => candidate.id === item.id))
                                                                ? [...new Set([...current.deletedBuiltInItemIds, item.id])]
                                                                : current.deletedBuiltInItemIds,
                                                        }))}
                                                    ><DeleteOutlineRoundedIcon /></button>
                                                </div>
                                            </article>
                                        );
                                    })}
                                </div>
                                <Button variant="outlined" startIcon={<AddRoundedIcon />} onClick={addItem}>新增粘贴项</Button>
                            </>
                        )}
                    </div>
                </section>
            )}
        </main>
    );
}
