import {
  AccountProfile,
  ChallengeOptions,
  type ChangePassword,
  Passkey,
  type Reauth,
  RecoveryCodes,
  RevokedSessions,
  SessionInfo,
  type UpdateAccount,
} from "@organizer/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { updateBrief } from "./accounts.ts";
import { api, apiVoid } from "./api.ts";
import { createPasskey, getPasskey } from "./webauthn.ts";

/** The signed-in account's own pages: profile, sign-in methods, sessions. Browser session only. */

export const accountKeys = {
  profile: ["account", "profile"] as const,
  passkeys: ["account", "passkeys"] as const,
  sessions: ["account", "sessions"] as const,
};

export const useAccountProfile = (enabled = true) =>
  useQuery({ queryKey: accountKeys.profile, queryFn: () => api(AccountProfile, "/account"), enabled });

export const usePasskeys = () =>
  useQuery({ queryKey: accountKeys.passkeys, queryFn: () => api(z.array(Passkey), "/account/passkeys") });

export const useSessions = () =>
  useQuery({ queryKey: accountKeys.sessions, queryFn: () => api(z.array(SessionInfo), "/account/sessions") });

/** Invalidates every account query once the mutation is done (profile counts follow passkeys etc.). */
function useAccountMutation<I, O>(run: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => client.invalidateQueries({ queryKey: ["account"] }),
  });
}

export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAccount) => api(AccountProfile, "/account", { method: "PATCH", body: input }),
    onSuccess: (profile) => {
      client.setQueryData(accountKeys.profile, profile);
      // The switcher and the status bar show the name and color from the browser's list.
      updateBrief(profile);
      void client.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export const useChangePassword = () =>
  useAccountMutation((input: ChangePassword) =>
    apiVoid("/account/password", { method: "POST", body: input }),
  );

export const useReplaceTotp = () =>
  useAccountMutation((input: { totpSecret: string; totpCode: string }) =>
    apiVoid("/account/totp", { method: "POST", body: input }),
  );

/** New recovery codes: a plain function, so the codes never enter the query cache. */
export const newRecoveryCodes = () => api(RecoveryCodes, "/account/recovery-codes", { method: "POST" });

/** Adds a passkey: options (needs a recent sign-in), the browser makes it, the server stores it. */
export async function addPasskey(name: string): Promise<Passkey | null> {
  const challenge = await api(ChallengeOptions, "/account/passkeys/options", { method: "POST" });
  const response = await createPasskey(challenge.options);
  if (!response) return null;
  return api(Passkey, "/account/passkeys", {
    method: "POST",
    body: { challengeId: challenge.challengeId, response, name },
  });
}

export const useRenamePasskey = () =>
  useAccountMutation(({ id, name }: { id: string; name: string }) =>
    api(Passkey, `/account/passkeys/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } }),
  );

export const useRemovePasskey = () =>
  useAccountMutation((id: string) =>
    apiVoid(`/account/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );

export const useRevokeSession = () =>
  useAccountMutation((id: string) =>
    apiVoid(`/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );

export const useRevokeOtherSessions = () =>
  useAccountMutation(() => api(RevokedSessions, "/account/sessions", { method: "DELETE" }));

export const deleteOwnAccount = (confirmUsername: string) =>
  apiVoid("/account", { method: "DELETE", body: { confirmUsername } });

/** Confirms it is the account's owner for the next 10 minutes (sensitive actions). */
export const reauth = (input: Reauth) => apiVoid("/auth/reauth", { method: "POST", body: input });

/** The passkey way of reauth; false when the person cancels. */
export async function reauthWithPasskey(): Promise<boolean> {
  const challenge = await api(ChallengeOptions, "/auth/reauth/passkey-options", { method: "POST" });
  const response = await getPasskey(challenge.options);
  if (!response) return false;
  await reauth({ challengeId: challenge.challengeId, response } as Reauth);
  return true;
}
