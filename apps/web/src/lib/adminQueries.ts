import {
  AdminAccount,
  AdminEvent,
  AdminSignup,
  InstanceBackup,
  InstanceInfo,
  ResetCodeResult,
} from "@organizer/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api, apiVoid } from "./api.ts";

/** The admin's pages: sign-ups, accounts (metadata only), backups and the log. Admin session only. */

export const adminKeys = {
  all: ["admin"] as const,
  signups: ["admin", "signups"] as const,
  accounts: ["admin", "accounts"] as const,
  events: ["admin", "events"] as const,
  instance: ["admin", "instance"] as const,
};

export const useSignups = (enabled = true) =>
  useQuery({
    queryKey: adminKeys.signups,
    queryFn: () => api(z.array(AdminSignup), "/admin/signups"),
    enabled,
    refetchInterval: 60_000,
  });

export const useAdminAccounts = () =>
  useQuery({ queryKey: adminKeys.accounts, queryFn: () => api(z.array(AdminAccount), "/admin/accounts") });

export const useAdminEvents = () =>
  useQuery({ queryKey: adminKeys.events, queryFn: () => api(z.array(AdminEvent), "/admin/events") });

export const useInstance = () =>
  useQuery({ queryKey: adminKeys.instance, queryFn: () => api(InstanceInfo, "/admin/instance") });

function useAdminMutation<I, O>(run: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => client.invalidateQueries({ queryKey: adminKeys.all }),
  });
}

export const useApproveSignup = () =>
  useAdminMutation((id: number) => api(AdminAccount, `/admin/signups/${id}/approve`, { method: "POST" }));

export const useRejectSignup = () =>
  useAdminMutation((id: number) => apiVoid(`/admin/signups/${id}/reject`, { method: "POST" }));

export type AccountAction = "disable" | "enable" | "unlock";

export const useAccountAction = () =>
  useAdminMutation(({ id, action }: { id: number; action: AccountAction }) =>
    api(AdminAccount, `/admin/accounts/${id}/${action}`, { method: "POST" }),
  );

/** A one-time code (24 h) the person uses on the reset page; shown to the admin once. */
export const useResetLogin = () =>
  useAdminMutation((id: number) =>
    api(ResetCodeResult, `/admin/accounts/${id}/reset-login`, { method: "POST" }),
  );

export const useDeleteAccount = () =>
  useAdminMutation(({ id, confirmUsername }: { id: number; confirmUsername: string }) =>
    apiVoid(`/admin/accounts/${id}`, { method: "DELETE", body: { confirmUsername } }),
  );

export const useBackupNow = () =>
  useAdminMutation(() => api(InstanceBackup, "/admin/backups", { method: "POST" }));
