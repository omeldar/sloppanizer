import type { Attachment } from "@organizer/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "../../components/markdown/MarkdownEditor.tsx";
import { MarkdownPreview } from "../../components/markdown/MarkdownPreview.tsx";
import { clearAttachmentCache } from "../../lib/attachmentCache.ts";
import { renderWithApp } from "../../test/render.tsx";
import DrawDialog from "./DrawDialog.tsx";
import { decodeStrokes, encodeStrokes } from "./model.ts";
import PhoneDrawPage from "./PhoneDrawPage.tsx";
import { readTextChunk, withTextChunk } from "./png.ts";
import { drawLine, stubCanvas, tinyPng } from "./testCanvas.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearAttachmentCache();
});

const TOKEN = "A".repeat(20) + "b_-".repeat(7) + "Z".repeat(2);

const attachment = (
  id: number,
  name = `drawing-2026-11-27-10${String(id).padStart(2, "0")}.png`,
): Attachment => ({
  id,
  name,
  mimeType: "image/png",
  size: 100,
  sha256: "a".repeat(64),
  url: `/api/v1/attachments/${id}/${name}`,
  inline: true,
  createdBy: "you",
  createdAt: "2026-11-27T10:00:00.000Z",
});

/** A stored drawing: a PNG with one blue stroke inside (bytes: a jsdom Blob would not reach Response). */
const storedDrawing = () =>
  withTextChunk(
    tinyPng(),
    encodeStrokes({
      width: 1600,
      height: 1000,
      background: null,
      strokes: [{ color: "#2563eb", size: 6, eraser: false, points: [100, 100, 50, 300, 300, 50] }],
    }),
  ) as Uint8Array<ArrayBuffer>;

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake API: JSON answers from `handler`, attachment files as stored drawings. */
function mockServer(handler: (call: Sent) => { status?: number; body?: unknown } | undefined) {
  const calls: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        path: input,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body,
      };
      calls.push(call);
      if (call.method === "GET" && /\/attachments\/\d+\//.test(call.path))
        return new Response(storedDrawing());
      const answer = handler(call) ?? { status: 404, body: { error: { code: "not_found", message: "No." } } };
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  let made = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${++made}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  return calls;
}

const fire = {
  pointerDown: fireEvent.pointerDown,
  pointerMove: fireEvent.pointerMove,
  pointerUp: fireEvent.pointerUp,
};

/** The strokes inside an uploaded PNG. */
async function strokesOf(file: Blob) {
  const text = readTextChunk(new Uint8Array(await file.arrayBuffer()));
  return text === null ? null : decodeStrokes(text);
}

describe("the drawing dialog", () => {
  it("draws with pointer events and stores a PNG with its strokes inside", async () => {
    const canvas = stubCanvas();
    mockServer(() => ({ body: { items: [] } }));
    const upload = vi.fn<(file: File) => Promise<Attachment>>(async () => attachment(7));
    const onDone = vi.fn<(file: { url: string }) => void>();
    renderWithApp(<DrawDialog open onOpenChange={() => undefined} upload={upload} onDone={onDone} />);
    const board = await screen.findByRole("img", { name: "Drawing canvas" });
    const insert = screen.getByRole("button", { name: "Insert" }) as HTMLButtonElement;
    expect(insert.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    drawLine(
      board,
      [
        [100, 100],
        [200, 150],
        [300, 250],
      ],
      fire,
    );
    expect(canvas.calls.filter((c) => c.startsWith("lineTo"))).not.toHaveLength(0);
    // A pen with pressure, and a palm touching meanwhile, which is ignored.
    drawLine(
      board,
      [
        [400, 100],
        [400, 300],
      ],
      fire,
      { pointerType: "pen", pressure: 0.9, pointerId: 2 },
    );
    drawLine(
      board,
      [
        [10, 10],
        [700, 400],
      ],
      fire,
      { pointerType: "touch", pointerId: 3 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));

    fireEvent.click(insert);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ url: attachment(7).url }));
    const file = upload.mock.calls[0]?.[0] as File;
    expect(file.name).toMatch(/^drawing-\d{4}-\d{2}-\d{2}-\d{4}\.png$/);
    expect(file.type).toBe("image/png");
    const page = await strokesOf(file);
    // 800x500 on screen is 1600x1000 on the page.
    expect(page?.strokes).toEqual([
      { color: "#dc2626", size: 6, eraser: false, points: [200, 200, 50, 400, 300, 50, 600, 500, 50] },
      { color: "#dc2626", size: 6, eraser: false, points: [800, 200, 90, 800, 600, 90] },
    ]);
  });

  it("asks before throwing a drawing away", async () => {
    stubCanvas();
    mockServer(() => ({ body: { items: [] } }));
    const onOpenChange = vi.fn<(open: boolean) => void>();
    renderWithApp(<DrawDialog open onOpenChange={onOpenChange} onDone={() => undefined} />);
    drawLine(
      await screen.findByRole("img", { name: "Drawing canvas" }),
      [
        [10, 10],
        [50, 50],
      ],
      fire,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep drawing" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("starts from a copy of a recent drawing", async () => {
    stubCanvas();
    const calls = mockServer((call) =>
      call.path.includes("/drawings?") ? { body: { items: [attachment(3)] } } : undefined,
    );
    const upload = vi.fn<(file: File) => Promise<Attachment>>(async () => attachment(8));
    renderWithApp(
      <DrawDialog open onOpenChange={() => undefined} upload={upload} onDone={() => undefined} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: `Copy ${attachment(3).name}` }));
    const insert = screen.getByRole("button", { name: "Insert" }) as HTMLButtonElement;
    await waitFor(() => expect(insert.disabled).toBe(false));
    fireEvent.click(insert);
    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect((await strokesOf(upload.mock.calls[0]?.[0] as File))?.strokes).toHaveLength(1);
    expect(calls.some((c) => c.path.endsWith("/api/v1/drawings?limit=12"))).toBe(true);
  });

  it("hands over to the phone: QR code, waiting, then the drawing to insert", async () => {
    let polls = 0;
    const calls = mockServer((call) => {
      if (call.path.endsWith("/drawings?limit=12")) return { body: { items: [] } };
      if (call.method === "POST" && call.path.endsWith("/drawings/handoffs")) {
        return { status: 201, body: { id: 4, token: TOKEN, expiresAt: "2026-11-27T10:10:00.000Z" } };
      }
      if (call.path.endsWith("/drawings/handoffs/4")) {
        polls += 1;
        const received = polls >= 2;
        return {
          body: {
            id: 4,
            status: received ? "received" : "waiting",
            expiresAt: "2026-11-27T10:10:00.000Z",
            attachment: received ? attachment(9) : null,
          },
        };
      }
      return undefined;
    });
    const onDone = vi.fn<(file: { url: string }) => void>();
    renderWithApp(<DrawDialog open onOpenChange={() => undefined} onDone={onDone} pollMs={10} />);
    fireEvent.click(await screen.findByRole("button", { name: "Draw on your phone" }));
    expect(await screen.findByRole("img", { name: "QR code to draw on your phone" })).toBeTruthy();
    expect(screen.getByText(/Waiting for your phone/)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "The drawing from your phone" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(onDone).toHaveBeenCalledWith({ url: attachment(9).url });
    // An arrived drawing ends the link on the server already; nothing more to end.
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("ends the phone link when the dialog closes before the drawing came", async () => {
    const calls = mockServer((call) => {
      if (call.method === "POST")
        return { status: 201, body: { id: 5, token: TOKEN, expiresAt: "2026-11-27T10:10:00.000Z" } };
      if (call.method === "DELETE") return { status: 204 };
      if (call.path.endsWith("/handoffs/5")) {
        return {
          body: { id: 5, status: "waiting", expiresAt: "2026-11-27T10:10:00.000Z", attachment: null },
        };
      }
      return { body: { items: [] } };
    });
    const view = renderWithApp(<DrawDialog open onOpenChange={() => undefined} onDone={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Draw on your phone" }));
    await screen.findByRole("img", { name: "QR code to draw on your phone" });
    view.unmount();
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/drawings/handoffs/5"))).toBe(true),
    );
  });
});

describe("Draw in the Markdown editor", () => {
  it("puts the drawing's image link where the cursor was", async () => {
    stubCanvas();
    mockServer(() => ({ body: { items: [] } }));
    const onChange = vi.fn<(text: string) => void>();
    const upload = vi.fn<(file: File) => Promise<Attachment>>(async () => attachment(12));
    renderWithApp(<MarkdownEditor label="Comment" value="See this:" onChange={onChange} upload={upload} />);
    await screen.findByLabelText("Comment");
    fireEvent.click(screen.getByRole("button", { name: "Draw" }));
    drawLine(
      await screen.findByRole("img", { name: "Drawing canvas" }),
      [
        [10, 10],
        [80, 60],
      ],
      fire,
    );
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(`See this: ![Drawing](${attachment(12).url})`),
    );
  });
});

describe("Edit drawing", () => {
  it("opens the stored strokes and swaps in the new file's link", async () => {
    stubCanvas();
    const replace = vi.fn<(from: string, to: string) => void>();
    const old = attachment(3).url;
    // The dialog's own upload (the attachments API) stores the new file.
    const calls = mockServer((call) =>
      call.method === "POST" ? { status: 201, body: attachment(13) } : undefined,
    );
    renderWithApp(<MarkdownPreview source={`Plan:\n\n![Drawing](${old})`} onReplaceLink={replace} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit drawing" }));
    const board = await screen.findByRole("img", { name: "Drawing canvas" });
    const save = screen.getByRole("button", { name: "Save drawing" }) as HTMLButtonElement;
    // Unchanged: nothing to save.
    expect(save.disabled).toBe(true);
    drawLine(
      board,
      [
        [500, 400],
        [600, 450],
      ],
      fire,
    );
    fireEvent.click(save);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(old, attachment(13).url));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toMatch(/^\/api\/v1\/attachments\?name=drawing-/);
    // The old stroke and the new one.
    expect((await strokesOf(post?.body as Blob))?.strokes).toHaveLength(2);
  });

  it("offers no edit without a way to change the text, and none on other images", async () => {
    mockServer(() => undefined);
    renderWithApp(<MarkdownPreview source={`![Drawing](${attachment(3).url})`} />);
    await screen.findByRole("link");
    expect(screen.queryByRole("button", { name: "Edit drawing" })).toBeNull();
  });
});

describe("the phone page", () => {
  it("checks the link, draws and sends the PNG with the token in a header, once", async () => {
    stubCanvas();
    const calls = mockServer((call) =>
      call.method === "GET" ? { body: { expiresAt: "2026-11-27T10:10:00.000Z" } } : { status: 204 },
    );
    renderWithApp(<PhoneDrawPage hash={`#${TOKEN}`} />);
    const send = (await screen.findByRole("button", { name: "Send" })) as HTMLButtonElement;
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(send.disabled).toBe(true);
    drawLine(
      screen.getByRole("img", { name: "Draw here" }),
      [
        [10, 10],
        [100, 100],
      ],
      fire,
      { pointerType: "touch" },
    );
    await act(async () => {
      fireEvent.click(send);
    });
    expect(await screen.findByRole("heading", { name: "Sent" })).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/v1/draw-handoff");
    expect(post?.headers["x-draw-token"]).toBe(TOKEN);
    expect(post?.headers.authorization).toBeUndefined();
    expect(calls.every((c) => !c.path.includes(TOKEN))).toBe(true);
    expect((await strokesOf(post?.body as Blob))?.strokes).toHaveLength(1);
  });

  it("says when the link no longer works", async () => {
    mockServer(() => ({
      status: 404,
      body: { error: { code: "not_found", message: "This drawing link has expired or was already used." } },
    }));
    renderWithApp(<PhoneDrawPage hash={`#${TOKEN}`} />);
    expect((await screen.findByRole("alert")).textContent).toContain("expired or was already used");
  });

  it("needs a token in the address", async () => {
    renderWithApp(<PhoneDrawPage hash="#nope" />);
    expect((await screen.findByRole("alert")).textContent).toContain("needs the code from the computer");
  });
});
