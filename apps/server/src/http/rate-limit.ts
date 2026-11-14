import type { FastifyReply } from "fastify";
import type { Clock } from "../clock.ts";
import { ApiError } from "./errors.ts";

/**
 * In-memory fixed-window counters, one limiter per route group (the API runs as one container). Login
 * lockouts per username are in the database instead (services/auth/throttle.ts), so a restart does not
 * lift them.
 */

export interface Verdict {
  ok: boolean;
  /** Seconds until the window ends (0 when ok). */
  retryAfterSeconds: number;
}

interface Window {
  start: number;
  count: number;
  /** Blocked until (ms), for limiters that block for longer than the window. */
  blockedUntil: number;
}

/** Keys kept per limiter; the oldest windows go first beyond it, so a flood of keys cannot fill memory. */
const MAX_KEYS = 50_000;

export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly clock: Clock;
  readonly limit: number;
  readonly windowMs: number;
  /** How long a key stays blocked once it is over the limit (default: the rest of the window). */
  readonly blockMs: number;

  constructor(clock: Clock, limit: number, windowMs: number, blockMs = 0) {
    this.clock = clock;
    this.limit = limit;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
  }

  private current(key: string, now: number): Window {
    let window = this.windows.get(key);
    if (window && now - window.start >= this.windowMs && window.blockedUntil <= now) {
      this.windows.delete(key);
      window = undefined;
    }
    if (!window) {
      window = { start: now, count: 0, blockedUntil: 0 };
      if (this.windows.size >= MAX_KEYS) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      this.windows.set(key, window);
    }
    return window;
  }

  private verdict(window: Window, now: number): Verdict {
    if (window.blockedUntil > now) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window.blockedUntil - now) / 1000)) };
    }
    if (window.count >= this.limit) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)),
      };
    }
    return { ok: true, retryAfterSeconds: 0 };
  }

  /** Counts one hit; refused when the key is over the limit (the refused hit is not counted). */
  take(key: string): Verdict {
    const now = this.clock().getTime();
    const window = this.current(key, now);
    const verdict = this.verdict(window, now);
    if (!verdict.ok) return verdict;
    window.count++;
    if (window.count >= this.limit && this.blockMs > 0) window.blockedUntil = now + this.blockMs;
    return verdict;
  }

  /** Whether a key may go on, without counting (for limits that count only failures). */
  check(key: string): Verdict {
    const now = this.clock().getTime();
    const window = this.windows.get(key);
    if (!window) return { ok: true, retryAfterSeconds: 0 };
    if (now - window.start >= this.windowMs && window.blockedUntil <= now)
      return { ok: true, retryAfterSeconds: 0 };
    return this.verdict(window, now);
  }

  reset(key: string): void {
    this.windows.delete(key);
  }
}

/** The 429 every limit answers with (the error handler adds Retry-After from the details). */
export function tooManyRequests(retryAfterSeconds: number, message?: string): ApiError {
  return new ApiError(
    "too_many_requests",
    message ?? `Too many requests. Try again in ${waitText(retryAfterSeconds)}.`,
    {
      retryAfterSeconds,
    },
  );
}

/** "45 seconds", "1 minute", "4 minutes". */
export function waitText(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Throws the 429 when the verdict refuses. */
export function enforce(verdict: Verdict, message?: string): void {
  if (!verdict.ok) throw tooManyRequests(verdict.retryAfterSeconds, message);
}

/** Sets Retry-After on a reply for a refused verdict (used where the reply is at hand). */
export function retryAfter(reply: FastifyReply, seconds: number): void {
  reply.header("Retry-After", String(seconds));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Every limiter of the app. */
export interface Limiters {
  /** Failed logins per IP: 20 in 15 minutes block that IP for 15 minutes. */
  loginFailuresByIp: FixedWindowLimiter;
  signupByIp: FixedWindowLimiter;
  setupByIp: FixedWindowLimiter;
  resetByIp: FixedWindowLimiter;
  resetByName: FixedWindowLimiter;
  passkeyOptionsByIp: FixedWindowLimiter;
  refreshBySession: FixedWindowLimiter;
  /** Also counts refresh calls with unknown tokens, per IP. */
  refreshByIp: FixedWindowLimiter;
  apiByAccount: FixedWindowLimiter;
  uploadsByAccount: FixedWindowLimiter;
  /** OAuth client registrations (open to anyone) per IP. */
  oauthRegisterByIp: FixedWindowLimiter;
  /** OAuth token calls (code and refresh grants) per IP. */
  oauthTokenByIp: FixedWindowLimiter;
  /** Calendar feed downloads (calendar apps poll) per IP. */
  calendarByIp: FixedWindowLimiter;
}

export function createLimiters(clock: Clock): Limiters {
  return {
    loginFailuresByIp: new FixedWindowLimiter(clock, 20, 15 * MINUTE, 15 * MINUTE),
    signupByIp: new FixedWindowLimiter(clock, 5, HOUR),
    setupByIp: new FixedWindowLimiter(clock, 5, HOUR),
    resetByIp: new FixedWindowLimiter(clock, 5, HOUR),
    resetByName: new FixedWindowLimiter(clock, 5, HOUR),
    passkeyOptionsByIp: new FixedWindowLimiter(clock, 30, MINUTE),
    refreshBySession: new FixedWindowLimiter(clock, 60, MINUTE),
    refreshByIp: new FixedWindowLimiter(clock, 120, MINUTE),
    apiByAccount: new FixedWindowLimiter(clock, 600, MINUTE),
    uploadsByAccount: new FixedWindowLimiter(clock, 60, MINUTE),
    oauthRegisterByIp: new FixedWindowLimiter(clock, 20, HOUR),
    oauthTokenByIp: new FixedWindowLimiter(clock, 60, MINUTE),
    calendarByIp: new FixedWindowLimiter(clock, 120, HOUR),
  };
}
