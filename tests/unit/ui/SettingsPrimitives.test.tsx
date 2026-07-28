import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Switch from "@mui/material/Switch";
import { describe, expect, it } from "vitest";
import AppThemeProvider from "../../../src/ui/AppThemeProvider";
import {
    SettingsRow,
    SettingsSection,
} from "../../../src/ui/settings/SettingsPrimitives";

describe("Settings primitives", () => {
    it("keeps the control accessible by its label", async () => {
        const user = userEvent.setup();
        render(
            <AppThemeProvider>
                <SettingsSection title="General">
                    <SettingsRow
                        label="Launch at login"
                        description="Start vPaste automatically"
                        control={<Switch inputProps={{ "aria-label": "Launch at login" }} />}
                    />
                </SettingsSection>
            </AppThemeProvider>,
        );

        const toggle = screen.getByRole("checkbox", { name: "Launch at login" });
        await user.click(toggle);

        expect(toggle).toBeChecked();
        expect(screen.getByText("Start vPaste automatically")).toBeVisible();
    });
});
