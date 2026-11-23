import {
  AdminAccount,
  AdminAccountsQuery,
  AdminEvent,
  AdminSignup,
  API_PREFIX,
  ConfirmUsername,
  IdParams,
  InstanceBackup,
  InstanceInfo,
  ResetCodeResult,
} from "@organizer/shared";
import type { FastifyRequest } from "fastify";
import { count, eq, sum } from "drizzle-orm";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DB_FILE } from "../data-dir.ts";
import { accounts } from "../db/auth-schema.ts";
import { schemaVersion } from "../db/index.ts";
import { attachments } from "../db/schema.ts";
import {
  type Actor,
  adminDeleteAccount,
  approveSignup,
  disableAccount,
  enableAccount,
  listAccounts,
  listSignups,
  rejectSignup,
  resetAccountLogin,
  unlockAccount,
} from "../services/auth/admin.ts";
import type { AuthServices } from "../services/auth/index.ts";
import { listAdminEvents } from "../services/auth/instance.ts";
import { createInstanceBackup, listBackups, nextBackupAt } from "../services/instance-backup.ts";
import type { App, Deps } from "./types.ts";

function actorOf(request: FastifyRequest): Actor {
  const caller = request.auth;
  if (caller?.via !== "session") throw new Error("admin route without an admin session");
  return { name: caller.account.username, accountId: caller.accountId };
}

function size(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * The admin dashboard's API. The security hook answers every caller that is not an admin's browser
 * session with the 404 of an unknown route, so the routes are invisible to everyone else. Changes need a
 * fresh sign-in. Nothing here returns account contents: only metadata.
 */
export function adminRoutes(app: App, deps: Deps, auth: AuthServices): void {
  const { db } = deps;
  const nowMs = () => deps.clock().getTime();
  const read = { access: "admin" as const };
  const change = { access: "admin" as const, reauth: true };
  const tags = ["admin"];

  app.get(
    `${API_PREFIX}/admin/signups`,
    {
      config: read,
      schema: { tags, summary: "Sign-ups waiting for approval", response: { 200: z.array(AdminSignup) } },
    },
    async () => listSignups(db),
  );
  app.post(
    `${API_PREFIX}/admin/signups/:id/approve`,
    {
      config: change,
      schema: { tags, summary: "Approve a sign-up", params: IdParams, response: { 200: AdminAccount } },
    },
    async (request) => approveSignup(db, nowMs(), actorOf(request), request.params.id),
  );
  app.post(
    `${API_PREFIX}/admin/signups/:id/reject`,
    { config: change, schema: { tags, summary: "Reject (delete) a sign-up", params: IdParams } },
    async (request, reply) => {
      rejectSignup(db, nowMs(), actorOf(request), request.params.id);
      return reply.status(204).send();
    },
  );

  app.get(
    `${API_PREFIX}/admin/accounts`,
    {
      config: read,
      schema: {
        tags,
        summary: "Accounts (metadata only)",
        querystring: AdminAccountsQuery,
        response: { 200: z.array(AdminAccount) },
      },
    },
    async (request) => listAccounts(db, nowMs(), request.query.status),
  );
  const accountAction = (path: string, summary: string, run: typeof disableAccount) =>
    app.post(
      `${API_PREFIX}/admin/accounts/:id/${path}`,
      { config: change, schema: { tags, summary, params: IdParams, response: { 200: AdminAccount } } },
      async (request) => run(db, nowMs(), actorOf(request), request.params.id),
    );
  accountAction("disable", "Disable an account (signs out every session)", disableAccount);
  accountAction("enable", "Enable a disabled account", enableAccount);
  accountAction("unlock", "Lift a login lock", unlockAccount);
  app.post(
    `${API_PREFIX}/admin/accounts/:id/reset-login`,
    {
      config: change,
      schema: {
        tags,
        summary: "Reset a lost login; the code is shown once",
        params: IdParams,
        response: { 200: ResetCodeResult },
      },
    },
    async (request) => resetAccountLogin(db, nowMs(), actorOf(request), request.params.id),
  );
  app.delete(
    `${API_PREFIX}/admin/accounts/:id`,
    {
      config: change,
      schema: {
        tags,
        summary: "Delete a disabled account with its data",
        params: IdParams,
        body: ConfirmUsername,
      },
    },
    async (request, reply) => {
      adminDeleteAccount(
        db,
        auth,
        nowMs(),
        actorOf(request),
        request.params.id,
        request.body.confirmUsername,
      );
      return reply.status(204).send();
    },
  );

  app.get(
    `${API_PREFIX}/admin/events`,
    {
      config: read,
      schema: { tags, summary: "Admin log (newest 200)", response: { 200: z.array(AdminEvent) } },
    },
    async () => listAdminEvents(db),
  );

  app.get(
    `${API_PREFIX}/admin/instance`,
    {
      config: read,
      schema: { tags, summary: "Version, sizes and backups", response: { 200: InstanceInfo } },
    },
    async () => {
      const byStatus = db
        .select({ status: accounts.status, n: count() })
        .from(accounts)
        .where(eq(accounts.kind, "user"))
        .groupBy(accounts.status)
        .all();
      const of = (status: string) => byStatus.find((row) => row.status === status)?.n ?? 0;
      const dbFile = join(deps.dataDir, DB_FILE);
      const files = db
        .select({ bytes: sum(attachments.size) })
        .from(attachments)
        .get();
      const backups = listBackups(auth.config.backupDir);
      return {
        version: deps.version,
        schemaVersion: schemaVersion(db),
        accounts: { pending: of("pending"), active: of("active"), disabled: of("disabled") },
        dbBytes: size(dbFile) + size(`${dbFile}-wal`),
        filesBytes: Number(files?.bytes ?? 0),
        backups: {
          lastAt: backups[0]?.createdAt ?? null,
          nextAt: nextBackupAt(nowMs(), auth.config.backupAt, auth.config.timeZone)?.toISOString() ?? null,
          keep: auth.config.backupKeep,
          files: backups.slice(0, 10),
        },
      };
    },
  );
  app.post(
    `${API_PREFIX}/admin/backups`,
    {
      config: change,
      schema: {
        tags,
        summary: "Back up the whole instance now (stays on the server)",
        response: { 201: InstanceBackup },
      },
    },
    async (request, reply) => {
      const backup = await createInstanceBackup({
        db,
        clock: deps.clock,
        backupDir: auth.config.backupDir,
        filesDir: auth.config.filesDir,
        keep: auth.config.backupKeep,
        version: deps.version,
        timeZone: auth.config.timeZone,
        actor: actorOf(request).name,
      });
      return reply.status(201).send(backup);
    },
  );
}
