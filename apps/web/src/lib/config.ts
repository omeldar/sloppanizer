import { API_PREFIX } from "@organizer/shared";

/**
 * Base URL of the API, from the build (VITE_API_URL, no trailing slash). Empty = the page's own origin:
 * `pnpm dev` through the Vite proxy and the server's local web mode.
 */
export const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

/** The full URL of an API path such as "/todos" (with its query string, if any). */
export const apiUrl = (path: string): string => `${API_BASE}${API_PREFIX}${path}`;
