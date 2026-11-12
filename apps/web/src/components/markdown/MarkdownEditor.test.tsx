import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api.ts";
import { mockApi, renderWithApp } from "../../test/render.tsx";
import { MarkdownEditor } from "./MarkdownEditor.tsx";

afterEach(() => vi.unstubAllGlobals());

const failingUpload = () => Promise.reject(new ApiError(413, "too_large", "Files can be up to 25 MB."));

function paste(target: Element, files: File[]) {
  fireEvent.paste(target, {
    clipboardData: { files, types: ["Files"], getData: () => "", items: [] },
  });
}

describe("MarkdownEditor file paste", () => {
  it("uploads a pasted image through the API and links it where the cursor was", async () => {
    const calls = mockApi(() => ({
      status: 201,
      body: {
        id: 12,
        name: "screenshot.png",
        mimeType: "image/png",
        size: 3,
        sha256: "a".repeat(64),
        url: "/api/v1/attachments/12/screenshot.png",
        inline: true,
        createdBy: "you",
        createdAt: "2026-11-12T10:00:00.000Z",
      },
    }));
    const onChange = vi.fn<(text: string) => void>();
    renderWithApp(<MarkdownEditor label="Comment" value="" onChange={onChange} />);
    const content = await screen.findByLabelText("Comment");

    paste(content, [new File(["png"], "screenshot.png", { type: "image/png" })]);

    expect(onChange).toHaveBeenCalledWith("![Uploading screenshot.png...]()");
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith("![screenshot.png](/api/v1/attachments/12/screenshot.png)"),
    );
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/attachments?name=screenshot.png" });
  });

  it("removes the placeholder and shows the server's message when the upload fails", async () => {
    const onChange = vi.fn<(text: string) => void>();
    renderWithApp(<MarkdownEditor label="Notes" value="Hi " onChange={onChange} upload={failingUpload} />);
    const content = await screen.findByLabelText("Notes");

    paste(content, [new File(["x"], "huge.zip")]);

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Could not attach huge.zip. Files can be up to 25 MB."),
    );
    expect(onChange).toHaveBeenLastCalledWith("Hi ");
  });

  it("sends with ctrl+enter when the editor has a submit action", async () => {
    const onSubmit = vi.fn<() => void>();
    renderWithApp(
      <MarkdownEditor
        label="Comment"
        value=""
        onChange={vi.fn<(text: string) => void>()}
        onSubmit={onSubmit}
      />,
    );
    const content = await screen.findByLabelText("Comment");
    fireEvent.keyDown(content, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
