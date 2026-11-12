import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "../../test/render.tsx";
import { type ChecklistControl, MarkdownPreview } from "./MarkdownPreview.tsx";

const toggleMock = () => vi.fn<ChecklistControl["onToggle"]>();

const SOURCE = [
  "Steps:",
  "",
  "- [ ] Order cables",
  "  - [x] Measure the rack",
  "1. [X] Book the van",
  "",
  "```",
  "- [ ] not an item in code",
  "```",
  "",
  "> - [ ] quoted, not counted",
].join("\n");

describe("checklist in the preview", () => {
  it("sends the clicked item's index and text, matched by line, nested and numbered too", async () => {
    const onToggle = toggleMock();
    renderWithApp(<MarkdownPreview source={SOURCE} checklist={{ onToggle }} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Measure the rack" }));
    expect(onToggle).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 1, text: "Measure the rack", checked: true }),
      false,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Order cables" }));
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ index: 0, line: 2 }), true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Book the van" }));
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ index: 2 }), false);
  });

  it("leaves quoted task lines read-only and shows code as code", async () => {
    renderWithApp(<MarkdownPreview source={SOURCE} checklist={{ onToggle: toggleMock() }} />);
    const boxes = (await screen.findAllByRole("checkbox")) as HTMLInputElement[];
    expect(boxes).toHaveLength(4);
    expect(boxes.filter((box) => box.disabled)).toHaveLength(1);
    expect(screen.getByText("- [ ] not an item in code")).toBeTruthy();
  });

  it("keeps every box read-only without a checklist control (notes, comments)", async () => {
    renderWithApp(<MarkdownPreview source={SOURCE} />);
    const boxes = (await screen.findAllByRole("checkbox")) as HTMLInputElement[];
    expect(boxes.every((box) => box.disabled)).toBe(true);
  });

  it("waits while a click is on its way", async () => {
    renderWithApp(<MarkdownPreview source={SOURCE} checklist={{ onToggle: toggleMock(), busy: true }} />);
    const box = (await screen.findByRole("checkbox", { name: "Order cables" })) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });
});
