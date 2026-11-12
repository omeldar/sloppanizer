import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLabel, mockApi, renderWithApp } from "../../test/render.tsx";
import { LabelsPage } from "./LabelsPage.tsx";

afterEach(() => vi.unstubAllGlobals());

const urgent = makeLabel("urgent", { id: 1 });
const high = makeLabel("prio::high", { id: 2, color: "#F2555A" });

function setup() {
  const conflict = {
    error: {
      code: "conflict",
      message: "Renaming would give 2 todos two scope labels.",
      details: {
        conflicts: [
          { todoId: 12, title: "Patch the router", labels: ["urgent", "prio::high", "homelab"] },
          { todoId: 15, title: "Renew certs", labels: ["prio::high", "urgent"] },
        ],
      },
    },
  };
  const calls = mockApi(({ method, path, body }) => {
    if (path === "/api/v1/labels" && method === "GET") return { body: [urgent, high] };
    if (method === "PATCH" && path === "/api/v1/labels/1") {
      const patch = body as { name?: string; onScopeConflict?: string };
      if (patch.onScopeConflict !== "replace") return { status: 409, body: conflict };
      return { body: makeLabel(patch.name ?? "urgent", { id: 1 }) };
    }
    if (path.startsWith("/api/v1/person-tags")) return { body: [] };
    return { status: 404, body: { error: { code: "not_found", message: "Not found" } } };
  });
  renderWithApp(<LabelsPage />);
  return calls;
}

async function rename(user: ReturnType<typeof userEvent.setup>, to: string) {
  const row = (await screen.findByText("urgent")).closest("li") as HTMLElement;
  await user.click(within(row).getByRole("button", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit urgent" });
  const name = within(dialog).getByLabelText(/^Name/);
  await user.clear(name);
  await user.type(name, to);
  await user.click(within(dialog).getByRole("button", { name: "Save label" }));
  return dialog;
}

describe("label rename into a used scope", () => {
  it("lists the affected todos and keeps the renamed label only after the user says so", async () => {
    const user = userEvent.setup();
    const calls = setup();
    const dialog = await rename(user, "prio::urgent");

    const conflict = await within(dialog).findByRole("region", { name: "Scope conflict" });
    const todos = within(conflict).getByRole("list", { name: "Affected todos" });
    expect(within(todos).getByText("#12")).toBeTruthy();
    expect(within(todos).getByText("Renew certs")).toBeTruthy();
    // Each todo shows the scope label it would lose, not its other labels.
    expect(within(todos).getAllByText("high")).toHaveLength(2);
    expect(within(todos).queryByText("homelab")).toBeNull();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    await user.click(within(conflict).getByRole("button", { name: "Keep the renamed label on them" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const patches = calls.filter((c) => c.method === "PATCH").map((c) => c.body);
    expect(patches).toEqual([{ name: "prio::urgent" }, { name: "prio::urgent", onScopeConflict: "replace" }]);
  });

  it("goes back to the form on Cancel without a second request", async () => {
    const user = userEvent.setup();
    const calls = setup();
    const dialog = await rename(user, "prio::urgent");
    const conflict = await within(dialog).findByRole("region", { name: "Scope conflict" });
    await user.click(within(conflict).getByRole("button", { name: "Cancel" }));
    expect(within(dialog).getByRole("button", { name: "Save label" })).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>(/^Name/).value).toBe("prio::urgent");
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
});
