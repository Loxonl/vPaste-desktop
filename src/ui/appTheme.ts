import { createTheme, type Theme } from "@mui/material/styles";
import type { ResolvedTheme } from "../theme";

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
                defaultProps: {
                    size: "small",
                },
                styleOverrides: {
                    root: {
                        width: 34,
                        height: 20,
                        padding: 0,
                    },
                    switchBase: {
                        padding: 2,
                        transitionDuration: "160ms",
                        "&.Mui-checked": {
                            transform: "translateX(14px)",
                            color: "#ffffff",
                            "& + .MuiSwitch-track": {
                                backgroundColor: "var(--ui-accent)",
                                opacity: 1,
                            },
                        },
                    },
                    thumb: {
                        width: 16,
                        height: 16,
                        boxShadow: "0 1px 4px rgba(31, 42, 55, 0.20)",
                    },
                    track: {
                        borderRadius: "var(--ui-radius-pill)",
                        backgroundColor: dark ? "#656a72" : "#aeb4bc",
                        opacity: 1,
                    },
                },
            },
            MuiTabs: {
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
                        transition: "background-color 140ms ease, color 140ms ease",
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
            MuiMenuItem: {
                styleOverrides: {
                    root: {
                        minHeight: "var(--ui-control-height)",
                        borderRadius: 6,
                        fontSize: 13,
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
