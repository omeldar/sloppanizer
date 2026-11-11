import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { inkOn } from "../lib/color.ts";
import { LabelPill } from "./LabelPill.tsx";

describe("LabelPill", () => {
  it("shows a scoped label as two parts: scope filled, value on the surface", () => {
    render(<LabelPill name="priority::high" color="#FFB224" />);
    const pill = screen.getByTitle("priority::high");
    expect(pill.dataset.kind).toBe("scoped");
    const [scope, value] = [...pill.children] as HTMLElement[];
    expect(scope?.textContent).toBe("priority");
    expect(value?.textContent).toBe("high");
    expect(pill.style.getPropertyValue("--label")).toBe("#FFB224");
  });

  it("splits at the last :: like GitLab", () => {
    render(<LabelPill name="env::prod::eu" color="#4C9AFF" />);
    const [scope, value] = [...screen.getByTitle("env::prod::eu").children] as HTMLElement[];
    expect(scope?.textContent).toBe("env::prod");
    expect(value?.textContent).toBe("eu");
  });

  it("shows a plain label as one filled part", () => {
    render(<LabelPill name="homelab" color="#2EC5CE" />);
    const pill = screen.getByTitle("homelab");
    expect(pill.dataset.kind).toBe("plain");
    expect(pill.children).toHaveLength(1);
    expect(pill.textContent).toBe("homelab");
  });

  it("picks the text color by contrast with the label color", () => {
    render(
      <>
        <LabelPill name="priority::high" color="#FFB224" />
        <LabelPill name="priority::low" color="#5B6573" />
      </>,
    );
    expect(screen.getByTitle("priority::high").style.getPropertyValue("--ink")).toBe("#12161C");
    expect(screen.getByTitle("priority::low").style.getPropertyValue("--ink")).toBe("#FFFFFF");
  });
});

describe("inkOn", () => {
  it.each([
    ["#FFFFFF", "#12161C"],
    ["#000000", "#FFFFFF"],
    ["#F2555A", "#12161C"],
    ["#1F3A93", "#FFFFFF"],
  ])("puts readable ink on %s", (fill, ink) => {
    expect(inkOn(fill)).toBe(ink);
  });
});
