import React from "react";
import ReactDOM from "react-dom/client";
import "./desktopBootstrap";
import AppThemeProvider from "./ui/AppThemeProvider";
import AppMotionProvider from "./ui/motion/AppMotionProvider";
import TextEditor from "./clipboard/TextEditor";

// The WinUI fallback only needs the editor, not the main window's router.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <AppMotionProvider>
            <AppThemeProvider><TextEditor /></AppThemeProvider>
        </AppMotionProvider>
    </React.StrictMode>,
);
