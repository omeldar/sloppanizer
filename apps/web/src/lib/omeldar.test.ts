import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmWithOmeldar, type OmeldarConfig } from "./omeldar.ts";

const config: OmeldarConfig = {
  issuer: "https://auth.example",
  clientId: "sloppanizer",
  redirectUri: "https://app.example/auth/callback",
} as OmeldarConfig;

/** Opens the confirm popup and returns the address it was opened with (the popup never answers). */
async function popupUrl(username?: string): Promise<URL> {
  vi.useFakeTimers();
  const open = vi.fn<(url?: string | URL) => Window | null>(() => ({}) as Window);
  vi.stubGlobal("open", open);
  const result = confirmWithOmeldar(config, username);
  await vi.waitFor(() => expect(open).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
  await expect(result).resolves.toBe(false);
  return new URL(String(open.mock.calls[0]?.[0]));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("confirmWithOmeldar", () => {
  it("asks auth for the signed-in account, so another account signed in at auth can't take its place", async () => {
    const url = await popupUrl("akotami");
    expect(url.origin + url.pathname).toBe("https://auth.example/authorize");
    expect(url.searchParams.get("login_hint")).toBe("akotami");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("max_age")).toBe("0");
  });

  it("sends no hint when the account isn't known yet", async () => {
    const url = await popupUrl();
    expect(url.searchParams.has("login_hint")).toBe(false);
  });
});
