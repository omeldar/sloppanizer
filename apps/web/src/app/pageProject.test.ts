import { describe, expect, it } from "vitest";
import { pageProjectSlug } from "./Layout.tsx";

describe("pageProjectSlug", () => {
  it("reads the project page slug", () => {
    expect(pageProjectSlug("/projects/home%20lab", {})).toBe("home lab");
  });

  it("reads the notes list filter, but not 'no project'", () => {
    expect(pageProjectSlug("/notes", { project: "work" })).toBe("work");
    expect(pageProjectSlug("/notes/4", { project: "work" })).toBe("work");
    expect(pageProjectSlug("/notes", { project: "none" })).toBeUndefined();
  });

  it("ignores a project search on other pages", () => {
    expect(pageProjectSlug("/board", { project: "work" })).toBeUndefined();
  });
});
