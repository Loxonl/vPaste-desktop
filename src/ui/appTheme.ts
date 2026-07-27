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
            },
            MuiTab: {
                styleOverrides: {
                    root: {
                        minHeight: 40,
                        borderRadius: "var(--ui-radius-control)",
                        textTransform: "none",
                        fontSize: 14,
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
                    },
                    bar: {
                        borderRadius: "var(--ui-radius-pill)",
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
