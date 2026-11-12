import { describe, expect, it } from "vitest";
import { formatBytes } from "./format.ts";

describe("formatBytes", () => {
  it("keeps bytes whole and uses one decimal from KB on", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(52_000)).toBe("50.8 KB");
    expect(formatBytes(13 * 1024 ** 2)).toBe("13.0 MB");
    expect(formatBytes(1024 ** 3 + 1)).toBe("1.0 GB");
  });
});
