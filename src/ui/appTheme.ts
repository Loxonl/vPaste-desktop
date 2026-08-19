import { createTheme, type Theme } from "@mui/material/styles";
import type { ResolvedTheme } from "../theme";
import { motionDurationsMs } from "./motion/tokens";

const lightPalette = {
    background: {
        default: "#f6f6f4",
        paper: "#ffffff",
    },
    text: {
        primary: "#1f242b",
        secondary: "#6f7883",
    },
};

const darkPalette = {
    background: {
        default: "#0f1012",
        paper: "#222222",
    },
    text: {
        primary: "#f2f3f5",
        secondary: "#a9adb3",
    },
};

export function createAppTheme(mode: ResolvedTheme): Theme {
    const dark = mode === "dark";

    return createTheme({
        transitions: {
            duration: {
                shortest: motionDurationsMs.quick,
                shorter: motionDurationsMs.fast,
                short: motionDurationsMs.fast,
                standard: motionDurationsMs.standard,
                complex: motionDurationsMs.slow,
                enteringScreen: motionDurationsMs.standard,
                leavingScreen: motionDurationsMs.fast,
            },
        },
        palette: {
            mode,
            primary: {
                main: dark ? "#4aa8ff" : "#1e92ee",
                dark: dark ? "#7cbcff" : "#0b73d7",
                contrastText: "#ffffff",
            },
            error: {
                main: dark ? "#ff7168" : "#d93025",
            },
            success: {
                main: dark ? "#65d9a0" : "#16734b",
            },
            warning: {
                main: dark ? "#ffd18a" : "#8a5208",
            },
            divider: dark ? "rgba(255,255,255,0.11)" : "rgba(26,35,46,0.09)",
            ...(dark ? darkPalette : lightPalette),
        },
        typography: {
            fontFamily: "var(--ui-font-family)",
            button: {
                textTransform: "none",
                fontWeight: 600,
                fontSize: 13,
            },
            body1: {
                fontSize: 14,
            },
            body2: {
                fontSize: 13,
            },
        },
        shape: {
            borderRadius: 8,
        },
        spacing: 4,
        components: {
            MuiButtonBase: {
                defaultProps: {
                    disableRipple: true,
                },
                styleOverrides: {
                    root: {
                        "&.Mui-focusVisible": {
                            boxShadow: "var(--ui-focus-ring)",
                            outline: "none",
                        },
                    },
                },
            },
            MuiButton: {
                defaultProps: {
                    size: "small",
                    disableElevation: true,
                },
                styleOverrides: {
                    root: {
                        minHeight: "var(--ui-control-height)",
                        borderRadius: "var(--ui-radius-control)",
                        paddingInline: 12,
                        lineHeight: 1.2,
                        "&.Mui-focusVisible": {
                            boxShadow: "var(--ui-focus-ring)",
                            outline: "none",
                        },
                    },
                    sizeSmall: {
                        minHeight: "var(--ui-control-compact)",
                        paddingInline: 10,
                    },
                },
            },
            MuiIconButton: {
                defaultProps: {
                    size: "small",
                },
                styleOverrides: {
                    root: {
                        width: "var(--ui-control-height)",
                        height: "var(--ui-control-height)",
                        borderRadius: "var(--ui-radius-control)",
                    },
                    sizeSmall: {
                        width: "var(--ui-control-compact)",
                        height: "var(--ui-control-compact)",
                    },
                },
            },
            MuiOutlinedInput: {
                styleOverrides: {
                    root: {
                        minHeight: "var(--ui-control-height)",
                        borderRadius: "var(--ui-radius-control)",
                        background: "var(--settings-input-bg)",
                        "&.Mui-focused": {
                            boxShadow: "var(--ui-focus-ring)",
                        },
                        "&.Mui-error.Mui-focused": {
                            boxShadow: "var(--ui-danger-focus-ring)",
                        },
                    },
                    input: {
                        paddingBlock: 6,
                        fontSize: 13,
                    },
                },
            },
            MuiSelect: {
                defaultProps: {
                    size: "small",
                },
            },
            MuiSwitch: {
                styleOverrides: {
                    root: {
                        width: 40,
                        height: 24,
                        padding: 0,
                    },
                    switchBase: {
                        padding: 2,
                        transitionDuration: "var(--motion-duration-fast)",
                        "&:hover": {
                            backgroundColor: "transparent",
                        },
                        "&.Mui-checked": {
                            transform: "translateX(16px)",
                            color: "#ffffff",
                            "& + .MuiSwitch-track": {
                                backgroundColor: "var(--ui-accent)",
                                opacity: 1,
                            },
                        },
                    },
                    thumb: {
                        width: 20,
                        height: 20,
                        boxShadow: "0 1px 4px rgba(31, 42, 55, 0.20)",
                    },
                    track: {
                        borderRadius: "var(--ui-radius-pill)",
                        backgroundColor: dark ? "#656a72" : "#aeb4bc",
                        opacity: 1,
                    },
                },
            },
            MuiFormControlLabel: {
                styleOverrides: {
                    root: {
                        gap: "var(--ui-space-2)",
                        marginLeft: 0,
                        marginRight: 0,
                    },
                    label: {
                        fontSize: 13,
                    },
                },
            },
            MuiTabs: {
                defaultProps: {
                    selectionFollowsFocus: true,
                },
                styleOverrides: {
                    flexContainer: {
                        gap: "var(--ui-space-1)",
                    },
                },
            },
            MuiTab: {
                styleOverrides: {
                    root: {
                        minHeight: 40,
                        width: "100%",
                        maxWidth: "100%",
                        minWidth: 0,
                        justifyContent: "flex-start",
                        borderRadius: "var(--ui-radius-control)",
                        paddingInline: 12,
                        textTransform: "none",
                        fontSize: 15,
                        fontWeight: 420,
                        color: "var(--settings-sidebar-text)",
                        transition: "background-color var(--motion-duration-fast) var(--motion-ease-standard), color var(--motion-duration-fast) var(--motion-ease-standard)",
                        "&.Mui-selected": {
                            color: "var(--settings-sidebar-selected-text)",
                            backgroundColor: "var(--settings-sidebar-selected-bg)",
                        },
                        "&:hover": {
                            backgroundColor: "var(--settings-sidebar-hover-bg)",
                        },
                        "& .MuiTab-iconWrapper": {
                            marginRight: 10,
                            color: "inherit",
                        },
                    },
                },
            },
            MuiPaper: {
                styleOverrides: {
                    root: {
                        backgroundImage: "none",
                    },
                    rounded: {
                        borderRadius: "var(--ui-radius-surface)",
                    },
                },
            },
            MuiList: {
                styleOverrides: {
                    root: {
                        overflow: "hidden",
                        padding: 0,
                        background: "var(--settings-card-bg)",
                        border: "1px solid var(--ui-border)",
                        borderRadius: "var(--ui-radius-surface)",
                        boxShadow: "var(--settings-card-shadow)",
                    },
                },
            },
            MuiListItem: {
                styleOverrides: {
                    root: {
                        minHeight: "var(--ui-settings-row-height)",
                        padding: "var(--ui-space-2) var(--ui-space-4)",
                    },
                },
            },
            MuiListItemText: {
                styleOverrides: {
                    primary: {
                        color: "var(--settings-text)",
                        fontSize: 14,
                        fontWeight: 400,
                        lineHeight: 1.35,
                    },
                    secondary: {
                        marginTop: 2,
                        color: "var(--settings-muted)",
                        fontSize: 12,
                        fontWeight: 350,
                        lineHeight: 1.35,
                    },
                },
            },
            MuiTypography: {
                styleOverrides: {
                    h5: {
                        color: "var(--settings-title)",
                        fontSize: 24,
                        fontWeight: 650,
                        lineHeight: 1.16,
                    },
                    subtitle2: {
                        color: "var(--settings-section-title)",
                        fontSize: 13,
                        fontWeight: 500,
                    },
                },
            },
            MuiMenu: {
                styleOverrides: {
                    paper: {
                        marginTop: "var(--ui-space-1)",
                        overflowX: "hidden",
                        overflowY: "auto",
                        backgroundColor: "var(--ui-surface-solid)",
                        border: "1px solid var(--ui-border-strong)",
                        borderRadius: "var(--ui-radius-control)",
                        boxShadow: "var(--ui-shadow)",
                    },
                    list: {
                        padding: 0,
                        overflow: "hidden",
                        background: "transparent",
                        border: 0,
                        borderRadius: 0,
                        boxShadow: "none",
                    },
                },
            },
            MuiMenuItem: {
                styleOverrides: {
                    root: {
                        minHeight: "var(--ui-control-height)",
                        borderRadius: 0,
                        fontSize: 13,
                        transition: "background-color var(--motion-duration-quick) var(--motion-ease-standard)",
                        "&:hover": {
                            backgroundColor: "var(--ui-surface-hover)",
                        },
                        "&.Mui-focusVisible": {
                            backgroundColor: "var(--ui-surface-hover)",
                            boxShadow: "none",
                            outline: "none",
                        },
                        "&.Mui-selected": {
                            backgroundColor: "var(--ui-accent-soft)",
                            "&:hover": {
                                backgroundColor: dark
                                    ? "rgba(74, 168, 255, 0.24)"
                                    : "rgba(30, 146, 238, 0.18)",
                            },
                            "&.Mui-focusVisible": {
                                backgroundColor: dark
                                    ? "rgba(74, 168, 255, 0.24)"
                                    : "rgba(30, 146, 238, 0.18)",
                                boxShadow: "none",
                                outline: "none",
                            },
                        },
                    },
                },
            },
            MuiDialog: {
                styleOverrides: {
                    paper: {
                        borderRadius: "var(--ui-radius-surface)",
                    },
                },
            },
            MuiLinearProgress: {
                styleOverrides: {
                    root: {
                        height: 5,
                        borderRadius: "var(--ui-radius-pill)",
                        backgroundColor: "var(--ui-accent-soft)",
                    },
                    bar: {
                        borderRadius: "var(--ui-radius-pill)",
                        backgroundColor: "var(--ui-accent-strong)",
                    },
                },
            },
            MuiTooltip: {
                defaultProps: {
                    arrow: true,
                },
            },
        },
    });
}
