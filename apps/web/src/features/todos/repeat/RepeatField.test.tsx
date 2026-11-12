import type { RecurrenceRule } from "@organizer/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "../../../test/render.tsx";
import { RepeatField, RepeatPanel } from "./RepeatField.tsx";

const pick = () => vi.fn<(rule: RecurrenceRule | null) => void>();

describe("repeat panel", () => {
  it("picks a preset in one click and marks the current one", async () => {
    const onPick = pick();
    renderWithApp(<RepeatPanel value={null} anchor="2026-11-12" onPick={onPick} />);
    const panel = await screen.findByRole("group", { name: "Repeat" });
    expect(within(panel).getByRole("button", { name: "Does not repeat" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(within(panel).getByRole("button", { name: /Every week on Thu/ }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ every: "week", weekdays: ["thu"] }));
  });

  it("builds a custom rule with a live preview and refuses a broken one", async () => {
    const onPick = pick();
    renderWithApp(<RepeatPanel value={null} anchor="2026-11-12" onPick={onPick} />);
    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    const form = screen.getByRole("form", { name: "Custom repeat" });
    fireEvent.change(within(form).getByLabelText("Interval"), { target: { value: "2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Mon" }));
    expect(within(form).getByText(/every 2 weeks on Mon, Thu\. Next: /)).toBeTruthy();

    // Counted from done: a plain interval, the weekday toggles go away.
    fireEvent.click(within(form).getByLabelText("from when it is done"));
    expect(within(form).getByText(/every 2 weeks after done\. Next: /)).toBeTruthy();
    expect(within(form).queryByRole("group", { name: "Weekdays" })).toBeNull();
    fireEvent.click(within(form).getByLabelText("from the schedule"));

    fireEvent.change(within(form).getByLabelText("Ends on"), { target: { value: "2026-11-01" } });
    expect(within(form).getByText(/ends \(2026-11-01\) before/)).toBeTruthy();
    const save = within(form).getByRole("button", { name: "Save repeat" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(form).getByRole("button", { name: "Never" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save repeat" }));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ every: "week", interval: 2, weekdays: ["mon", "thu"] }),
    );
  });

  it("is disabled with a hint when the todo has no date", async () => {
    renderWithApp(
      <RepeatField value={null} anchor={null} open={false} onOpenChange={() => {}} onChange={() => {}} />,
    );
    const field = (await screen.findByRole("button", { name: "Repeat" })) as HTMLButtonElement;
    expect(field.disabled).toBe(true);
    expect(screen.getByText("Set a due date or planned day first.")).toBeTruthy();
  });
});
