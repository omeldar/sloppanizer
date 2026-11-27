import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fileMarkdown,
  insertAtCursor,
  insertUploads,
  pendingUploads,
  placeholderText,
  type UploadedFile,
} from "./uploads.ts";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function editor(doc: string, cursor = doc.length) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [pendingUploads] }),
  });
  return view;
}

/** An upload the test resolves or rejects by hand. */
function deferredUpload() {
  const waiting = new Map<string, { resolve: (f: UploadedFile) => void; reject: (e: unknown) => void }>();
  const upload = vi.fn<(file: File) => Promise<UploadedFile>>(
    (file) => new Promise((resolve, reject) => waiting.set(file.name, { resolve, reject })),
  );
  return { upload, waiting };
}

const png = (name = "shot.png") => new File(["x"], name, { type: "image/png" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("insertUploads", () => {
  it("shows a placeholder at the cursor and swaps it for an image link", async () => {
    const v = editor("Before  after", 7);
    const { upload, waiting } = deferredUpload();
    const done = insertUploads(v, [png()], upload, vi.fn());
    expect(v.state.doc.toString()).toBe(`Before ${placeholderText(png())} after`);
    waiting
      .get("shot.png")
      ?.resolve({ name: "shot.png", url: "/api/v1/attachments/7/shot.png", inline: true });
    await done;
    expect(v.state.doc.toString()).toBe("Before ![shot.png](/api/v1/attachments/7/shot.png) after");
  });

  it("links other files as downloads, not images", () => {
    expect(fileMarkdown({ name: "report.pdf", url: "/api/v1/attachments/3/report.pdf", inline: false })).toBe(
      "[report.pdf](/api/v1/attachments/3/report.pdf)",
    );
  });

  it("removes the placeholder and reports the error when the upload fails", async () => {
    const v = editor("Text ");
    const onError = vi.fn<(file: File, error: unknown) => void>();
    const failure = new Error("Files can be up to 25 MB.");
    await insertUploads(v, [png("big.png")], () => Promise.reject(failure), onError);
    expect(v.state.doc.toString()).toBe("Text ");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: "big.png" }), failure);
    expect(v.state.field(pendingUploads)).toEqual([]);
  });

  it("still replaces the right text after edits above the placeholder", async () => {
    const v = editor("end", 0);
    const { upload, waiting } = deferredUpload();
    const done = insertUploads(v, [png()], upload, vi.fn());
    v.dispatch({ changes: { from: 0, insert: "Typed meanwhile. " } });
    waiting
      .get("shot.png")
      ?.resolve({ name: "shot.png", url: "/api/v1/attachments/1/shot.png", inline: true });
    await done;
    expect(v.state.doc.toString()).toBe("Typed meanwhile. ![shot.png](/api/v1/attachments/1/shot.png)end");
  });

  it("keeps two files with the same name in their own places", async () => {
    const v = editor("");
    let n = 0;
    await insertUploads(
      v,
      [png("image.png"), png("image.png")],
      async (file) => ({ name: file.name, url: `/api/v1/attachments/${++n}/image.png`, inline: true }),
      vi.fn(),
    );
    expect(v.state.doc.toString()).toBe(
      "![image.png](/api/v1/attachments/1/image.png)\n\n![image.png](/api/v1/attachments/2/image.png)",
    );
  });

  it("puts several files in their own paragraphs, apart from the text before and after", async () => {
    const v = editor("Body text\nmore", "Body text\n".length);
    let n = 0;
    await insertUploads(
      v,
      [new File(["x"], "report.xyz"), new File(["x"], "notes.pdf")],
      async (file) => ({ name: file.name, url: `/api/v1/attachments/${++n}/${file.name}`, inline: false }),
      vi.fn(),
    );
    expect(v.state.doc.toString()).toBe(
      "Body text\n\n[report.xyz](/api/v1/attachments/1/report.xyz)\n\n[notes.pdf](/api/v1/attachments/2/notes.pdf)\n\nmore",
    );
    // Typing goes on right after the last file.
    expect(v.state.doc.sliceString(0, v.state.selection.main.head).endsWith("notes.pdf)")).toBe(true);
  });

  it("keeps a single file off the link or word right before it", async () => {
    const v = editor("[notes.pdf](/api/v1/attachments/2/notes.pdf)");
    await insertUploads(
      v,
      [png("pic.png")],
      async () => ({ name: "pic.png", url: "/api/v1/attachments/3/pic.png", inline: true }),
      vi.fn(),
    );
    expect(v.state.doc.toString()).toBe(
      "[notes.pdf](/api/v1/attachments/2/notes.pdf) ![pic.png](/api/v1/attachments/3/pic.png)",
    );
  });

  it("leaves text alone when the placeholder was deleted by hand during the upload", async () => {
    const v = editor("");
    const { upload, waiting } = deferredUpload();
    const done = insertUploads(v, [png()], upload, vi.fn());
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "new text" } });
    await tick();
    waiting
      .get("shot.png")
      ?.resolve({ name: "shot.png", url: "/api/v1/attachments/1/shot.png", inline: true });
    await done;
    expect(v.state.doc.toString()).toBe("new text");
  });

  it("escapes brackets in file names so the link stays valid", () => {
    expect(fileMarkdown({ name: "a]b[c.png", url: "/api/v1/attachments/1/a-b-c.png", inline: true })).toBe(
      "![a\\]b\\[c.png](/api/v1/attachments/1/a-b-c.png)",
    );
  });
});

describe("insertAtCursor", () => {
  it("puts a drawing's link at the cursor, apart from the words around it", () => {
    const v = editor("See this:and that", 9);
    insertAtCursor(v, "![Drawing](/d.png)");
    expect(v.state.doc.toString()).toBe("See this: ![Drawing](/d.png) and that");
    expect(v.state.selection.main.head).toBe("See this: ![Drawing](/d.png)".length);
    const empty = editor("");
    insertAtCursor(empty, "![Drawing](/d.png)");
    expect(empty.state.doc.toString()).toBe("![Drawing](/d.png)");
  });
});
