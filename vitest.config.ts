import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileTypeIconsPlugin } from "./scripts/vite-file-type-icons";

export default defineConfig({
    plugins: [react(), fileTypeIconsPlugin()],
    test: {
        environment: "jsdom",
        setupFiles: ["./tests/setup.ts"],
        include: ["tests/unit/**/*.test.{ts,tsx}"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            include: ["src/ui/**/*.{ts,tsx}", "src/config/**/*.{ts,tsx}"],
        },
    },
});
