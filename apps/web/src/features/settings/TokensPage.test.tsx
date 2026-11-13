import type { ApiToken } from "@organizer/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMe, mockApi, renderWithApp } from "../../test/render.tsx";
import { expiresAtFor, isActive, TokensPage } from "./TokensPage.tsx";

const T = "2026-11-01T09:00:00.000Z";
const RAW = `spz_${"A1b2".repeat(10)}`;

function token(id: number, name: string, overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id,
    name,
    prefix: `spz_${String(id).padStart(8, "x")}`,
    scope: "read",
    createdAt: T,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

function setup(via: "session" | "token" = "session") {
  let list: ApiToken[] = [
    token(1, "MCP laptop", { scope: "write", lastUsedAt: T }),
    token(2, "Old script", { revokedAt: "2026-11-05T10:00:00.000Z" }),
    token(3, "Expired one", { expiresAt: "2026-01-01T00:00:00.000Z" }),
  ];
  const calls = mockApi(({ method, path, body }) => {
    if (path === "/api/v1/me") return { body: makeMe({ actor: via === "session" ? "you" : "bot", via }) };
    if (method === "GET" && path === "/api/v1/tokens") return { body: list };
    if (method === "POST" && path === "/api/v1/tokens") {
      const input = body as { name: string; scope: "read" | "write"; expiresAt: string | null };
      const created = token(4, input.name, { scope: input.scope, expiresAt: input.expiresAt });
      list = [created, ...list];
      return { status: 201, body: { token: created, raw: RAW } };
    }
    if (method === "DELETE" && path === "/api/v1/tokens/1") {
      const revoked = list.find((t) => t.id === 1);
      if (revoked) revoked.revokedAt = "2026-11-12T10:00:00.000Z";
      return { status: 204 };
    }
    return { status: 404, body: { error: { code: "not_found", message: "Not found" } } };
  });
  return { calls, ...renderWithApp(<TokensPage />) };
}

describe("token page", () => {
  it("lists active tokens and keeps revoked and expired ones in a collapsed group", async () => {
    setup();
    const active = await screen.findByRole("list", { name: "Active tokens" });
    expect(within(active).getByText("MCP laptop")).toBeTruthy();
    expect(within(active).queryByText("Old script")).toBeNull();
    const group = screen.getByText("Revoked and expired (2)").closest("details");
    expect(group?.open).toBe(false);
    expect(within(group as HTMLElement).getByText(/^Expired 202[56]-/)).toBeTruthy();
  });

  it("shows the raw value once after create and keeps it out of every cache", async () => {
    const user = userEvent.setup();
    const { calls, client } = setup();
    await screen.findByText("MCP laptop");
    await user.click(screen.getByRole("button", { name: /New token/ }));
    const dialog = await screen.findByRole("dialog", { name: "New token" });
    await user.type(within(dialog).getByLabelText(/^Name/), "Backup job");
    await user.click(within(dialog).getByLabelText(/Write:/));
    fireEvent.change(within(dialog).getByLabelText("Expires"), { target: { value: "30" } });
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));

    const panel = await screen.findByRole("region", { name: "New token Backup job" });
    expect(within(panel).getByText(RAW)).toBeTruthy();
    expect(within(panel).getByText("Copy it now. It is not shown again.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    const sent = post?.body as { name: string; scope: string; expiresAt: string };
    expect(sent.name).toBe("Backup job");
    expect(sent.scope).toBe("write");
    const days = (Date.parse(sent.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    // The list refreshes, but the raw value is in no cache, no URL and no storage.
    await within(await screen.findByRole("list", { name: "Active tokens" })).findByText("Backup job");
    const cached = JSON.stringify([
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    ]);
    expect(cached).not.toContain(RAW);
    expect(window.location.href).not.toContain(RAW);
    expect(JSON.stringify({ ...localStorage })).not.toContain(RAW);

    await user.click(within(panel).getByRole("button", { name: "Done" }));
    expect(screen.queryByText(RAW)).toBeNull();
  });

  it("drops the raw value when the page is left", async () => {
    const user = userEvent.setup();
    const { unmount } = setup();
    await screen.findByText("MCP laptop");
    await user.click(screen.getByRole("button", { name: /New token/ }));
    const dialog = await screen.findByRole("dialog", { name: "New token" });
    await user.type(within(dialog).getByLabelText(/^Name/), "Temp");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await screen.findByText(RAW);
    unmount();
    setup();
    await screen.findByText("MCP laptop");
    expect(screen.queryByText(RAW)).toBeNull();
  });

  it("revokes only after the confirm", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const active = await screen.findByRole("list", { name: "Active tokens" });
    await user.click(within(active).getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke MCP laptop?" });
    expect(within(dialog).getByText("Programs using this token stop working right away.")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Revoke token" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/tokens/1")).toBe(true),
    );
    await screen.findByText("Revoked and expired (3)");
  });

  it("looks like a missing page to a token and never asks for the list", async () => {
    const { calls } = setup("token");
    await screen.findByText("Page not found");
    expect(calls.some((c) => c.path === "/api/v1/tokens")).toBe(false);
  });
});

describe("token helpers", () => {
  it("turns the expiry choice into a time", () => {
    const now = new Date("2026-11-12T10:00:00.000Z");
    expect(expiresAtFor("never", now)).toBeNull();
    expect(expiresAtFor("90", now)).toBe("2027-02-10T10:00:00.000Z");
  });

  it("counts a token as active until it is revoked or past its expiry", () => {
    const now = new Date("2026-11-12T10:00:00.000Z");
    expect(isActive(token(1, "a"), now)).toBe(true);
    expect(isActive(token(1, "a", { expiresAt: "2026-11-12T10:00:01.000Z" }), now)).toBe(true);
    expect(isActive(token(1, "a", { expiresAt: "2026-11-12T10:00:00.000Z" }), now)).toBe(false);
    expect(isActive(token(1, "a", { revokedAt: T }), now)).toBe(false);
  });
});
