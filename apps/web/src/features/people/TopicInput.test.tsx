import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, renderWithApp } from "../../test/render.tsx";
import { bestMatch, TopicInput, topicToAdd } from "./TopicInput.tsx";

afterEach(() => vi.unstubAllGlobals());

function setup(topics: string[] = [], props: { existingOnly?: boolean } = {}) {
  const onAdd = vi.fn<(name: string) => void>();
  const onRemove = vi.fn<(name: string) => void>();
  const calls = mockApi(({ path }) =>
    path.startsWith("/api/v1/topics")
      ? {
          body: [
            { id: 1, name: "Firewall rules", peopleCount: 2 },
            { id: 2, name: "VPN", peopleCount: 1 },
          ],
        }
      : { status: 404 },
  );
  renderWithApp(<TopicInput topics={topics} onAdd={onAdd} onRemove={onRemove} {...props} />);
  return { onAdd, onRemove, calls, input: () => screen.getByRole("combobox", { name: "Add a topic" }) };
}

describe("TopicInput keys", () => {
  it("adds the typed topic on Enter, with spaces tidied", async () => {
    const { onAdd, input } = setup();
    await userEvent.type(await waitFor(input), "  SAP   access {Enter}");
    expect(onAdd).toHaveBeenCalledWith("SAP access");
    expect(input()).toHaveProperty("value", "");
  });

  it("adds on a comma too, since topic names cannot hold one", async () => {
    const { onAdd, input } = setup();
    await userEvent.type(await waitFor(input), "DNS,");
    expect(onAdd).toHaveBeenCalledWith("DNS");
  });

  it("removes the last topic with Backspace in the empty input", async () => {
    const { onRemove, input } = setup(["DNS", "VPN"]);
    await userEvent.type(await waitFor(input), "{Backspace}");
    expect(onRemove).toHaveBeenCalledWith("VPN");
  });

  it("keeps Backspace for the text while there is some", async () => {
    const { onRemove, input } = setup(["DNS"]);
    await userEvent.type(await waitFor(input), "ab{Backspace}");
    expect(onRemove).not.toHaveBeenCalled();
    expect(input()).toHaveProperty("value", "a");
  });

  it("picks a suggestion from /topics with the arrow keys, skipping topics already there", async () => {
    const { onAdd, input, calls } = setup(["vpn"]);
    await userEvent.type(await waitFor(input), "fi");
    await screen.findByRole("option", { name: "Firewall rules" });
    expect(screen.queryByRole("option", { name: "VPN" })).toBeNull();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onAdd).toHaveBeenCalledWith("Firewall rules");
    expect(calls.some((c) => c.path.startsWith("/api/v1/topics?q=fi"))).toBe(true);
  });

  it("does not add a topic the person already has, in any spelling", async () => {
    const { onAdd, input } = setup(["DNS"]);
    await userEvent.type(await waitFor(input), "dns{Enter}");
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("TopicInput as a filter (existing topics only)", () => {
  it("highlights the first match and takes it on Enter instead of the typed text", async () => {
    const { onAdd, input } = setup([], { existingOnly: true });
    await userEvent.type(await waitFor(input), "firewall");
    const option = await screen.findByRole("option", { name: "Firewall rules" });
    expect(option.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(onAdd).toHaveBeenCalledWith("Firewall rules");
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("takes the match once it arrives when Enter comes before the topics", async () => {
    const { onAdd, input } = setup([], { existingOnly: true });
    await userEvent.type(await waitFor(input), "wall{Enter}");
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("Firewall rules"));
  });

  it("says so when no topic matches and adds nothing", async () => {
    const { onAdd, input } = setup([], { existingOnly: true });
    await userEvent.type(await waitFor(input), "kubernetes");
    expect((await screen.findByRole("status")).textContent).toBe(
      'No topic matches "kubernetes". Check the spelling, or search by name above.',
    );
    await userEvent.keyboard("{Enter}");
    expect(onAdd).not.toHaveBeenCalled();
    expect(input()).toHaveProperty("value", "kubernetes");
  });

  it("still moves through matches with the arrow keys", async () => {
    const { onAdd, input } = setup([], { existingOnly: true });
    await userEvent.type(await waitFor(input), "v");
    await screen.findByRole("option", { name: "VPN" });
    // "VPN" holds the v, "Firewall rules" does not: only one match, the arrows stay on it.
    expect(screen.queryByRole("option", { name: "Firewall rules" })).toBeNull();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onAdd).toHaveBeenCalledWith("VPN");
  });
});

describe("bestMatch", () => {
  it("prefers the same name in any case, else the first match", () => {
    expect(bestMatch("vpn", ["VPN access", "VPN"])).toBe("VPN");
    expect(bestMatch("fire", ["Firewall rules", "Fire alarm"])).toBe("Firewall rules");
    expect(bestMatch("x", [])).toBeUndefined();
  });
});

describe("topicToAdd", () => {
  it("prefers the highlighted suggestion and caps typed names at 60 characters", () => {
    expect(topicToAdd("fire", "Firewall rules")).toBe("Firewall rules");
    expect(topicToAdd("x".repeat(80), undefined)).toHaveLength(60);
    expect(topicToAdd("   ", undefined)).toBeNull();
  });
});
