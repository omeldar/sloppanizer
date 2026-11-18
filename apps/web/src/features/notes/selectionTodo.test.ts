import { describe, expect, it } from "vitest";
import { selectionToTodo } from "./selectionTodo.ts";

describe("selectionToTodo", () => {
  it("puts a selection on one line as the title", () => {
    expect(selectionToTodo("  Renew the\ncerts\r\n\tbefore  Friday \n", "title")).toEqual({
      title: "Renew the certs before Friday",
    });
  });

  it("keeps the line breaks of a description and drops blank lines around it", () => {
    expect(selectionToTodo("\n\n- [ ] step one\n  - detail\n\n- [ ] step two  \n\n", "description")).toEqual({
      descriptionMd: "- [ ] step one\n  - detail\n\n- [ ] step two",
    });
  });

  it("keeps the indent of the first line of a description", () => {
    expect(selectionToTodo("    code line\n    next", "description")).toEqual({
      descriptionMd: "    code line\n    next",
    });
  });

  it("gives empty values for a selection of only spaces and line breaks", () => {
    expect(selectionToTodo(" \n\t \n", "title")).toEqual({ title: "" });
    expect(selectionToTodo(" \n\t \n", "description")).toEqual({ descriptionMd: "" });
  });
});
