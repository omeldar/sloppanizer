import {
  CreatedDrawHandoff,
  DRAW_TOKEN_HEADER,
  DrawHandoff,
  DrawingList,
  PhoneDrawHandoff,
} from "@organizer/shared";
import { api, apiVoid } from "../../lib/api.ts";
import { ApiError, NETWORK_MESSAGE, responseError, safeJson } from "../../lib/apiError.ts";
import { apiUrl } from "../../lib/config.ts";

/** The account's (or the tab's shared project's) recent drawings, newest first. */
export const recentDrawings = () => api(DrawingList, "/drawings", { query: { limit: 12 } });

/** A phone link for one drawing (browser session only). */
export const startHandoff = () => api(CreatedDrawHandoff, "/drawings/handoffs", { method: "POST" });

export const handoffStatus = (id: number) => api(DrawHandoff, `/drawings/handoffs/${id}`);

export const endHandoff = (id: number) => apiVoid(`/drawings/handoffs/${id}`, { method: "DELETE" });

/** The address the phone opens: the token only in the fragment, which browsers never send to a server. */
export const phoneLink = (token: string, origin = location.origin) => `${origin}/draw#${token}`;

/** The phone's calls: no session, the token only in its header (never in a URL, which servers log). */
async function phoneFetch(token: string, method: "GET" | "POST", body?: Blob): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/draw-handoff"), {
      method,
      credentials: "omit",
      headers: {
        accept: "application/json",
        [DRAW_TOKEN_HEADER]: token,
        ...(body ? { "content-type": "image/png" } : {}),
      },
      ...(body ? { body } : {}),
    });
  } catch {
    throw new ApiError(0, "network", NETWORK_MESSAGE);
  }
  const text = await response.text();
  const json = text ? safeJson(text) : null;
  if (!response.ok) throw responseError(response.status, json);
  return json;
}

/** Whether the phone's link still works, and until when. */
export async function checkPhoneLink(token: string): Promise<PhoneDrawHandoff> {
  const parsed = PhoneDrawHandoff.safeParse(await phoneFetch(token, "GET"));
  if (!parsed.success) throw new ApiError(200, "bad_response", "Unexpected answer. Reload the page.");
  return parsed.data;
}

export const sendFromPhone = async (token: string, png: Blob): Promise<void> => {
  await phoneFetch(token, "POST", png);
};
