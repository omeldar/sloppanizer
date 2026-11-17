import { describe, expect, it } from "vitest";
import { mailtoUrl, normalizeTopic } from "./people.ts";

describe("normalizeTopic", () => {
  it("trims and collapses inner whitespace, keeps the spelling", () => {
    expect(normalizeTopic("  Firewall \t  rules\n")).toBe("Firewall rules");
    expect(normalizeTopic("SAP")).toBe("SAP");
    expect(normalizeTopic("   ")).toBe("");
  });
});

describe("mailtoUrl", () => {
  it("keeps the @ readable and encodes the rest and the subject", () => {
    expect(mailtoUrl("max.muster@example.com")).toBe("mailto:max.muster@example.com");
    expect(mailtoUrl("a+b?c@example.com")).toBe("mailto:a%2Bb%3Fc@example.com");
    expect(mailtoUrl("max@example.com", "#142 Renew certs & keys")).toBe(
      "mailto:max@example.com?subject=%23142%20Renew%20certs%20%26%20keys",
    );
  });
});
