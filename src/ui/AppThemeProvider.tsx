import { useMemo, useSyncExternalStore, type PropsWithChildren } from "react";
import { StyledEngineProvider, ThemeProvider } from "@mui/material/styles";
import { getResolvedTheme, subscribeResolvedTheme } from "../theme";
import { createAppTheme } from "./appTheme";

export default function AppThemeProvider({ children }: PropsWithChildren) {
    const resolvedTheme = useSyncExternalStore(
        subscribeResolvedTheme,
        getResolvedTheme,
        getResolvedTheme,
    );
    const theme = useMemo(() => createAppTheme(resolvedTheme), [resolvedTheme]);

    return (
        <StyledEngineProvider injectFirst>
            <ThemeProvider theme={theme}>{children}</ThemeProvider>
        </StyledEngineProvider>
    );
}
