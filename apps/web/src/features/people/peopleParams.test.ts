import { describe, expect, it } from "vitest";
import { queryString } from "../../lib/api.ts";
import { splitList } from "./filters.tsx";
import { peopleParams } from "./PeoplePage.tsx";

describe("people filters in the URL", () => {
  it("turns the URL's comma lists into the API query, all filters together", () => {
    const params = peopleParams({
      q: "  max ",
      topic: "Firewall rules,VPN",
      team: "Network team",
      tag: "fast reply",
      kind: "contact",
      sort: "contact",
    });
    expect(params).toEqual({
      q: "max",
      topic: ["Firewall rules", "VPN"],
      team: "Network team",
      tag: ["fast reply"],
      kind: "contact",
      sort: "contact",
    });
    expect(queryString({ ...params })).toBe(
      "?q=max&topic=Firewall+rules%2CVPN&team=Network+team&tag=fast+reply&kind=contact&sort=contact",
    );
  });

  it("leaves out empty filters so the plain list has no query", () => {
    expect(queryString({ ...peopleParams({ q: "  " }) })).toBe("");
    expect(splitList(undefined)).toEqual([]);
    expect(splitList("a,,b")).toEqual(["a", "b"]);
  });
});
