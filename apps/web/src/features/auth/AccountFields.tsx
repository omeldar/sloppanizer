import { DisplayName, Username } from "@organizer/shared";
import { Field, TextInput } from "../../components/ui.tsx";
import styles from "./Auth.module.css";

export interface AccountDraft {
  displayName: string;
  username: string;
}

/** Display name and username of a new account; the username is fixed later (it is in the address). */
export function AccountFields({
  draft,
  onChange,
}: {
  draft: AccountDraft;
  onChange: (draft: AccountDraft) => void;
}) {
  return (
    <>
      <Field label="Display name" hint="Shown in the app and in the account menu.">
        <TextInput
          value={draft.displayName}
          onChange={(event) => onChange({ ...draft, displayName: event.target.value })}
          autoComplete="name"
          maxLength={60}
          required
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the step's first field
          autoFocus
        />
      </Field>
      <Field label="Username" hint="Lowercase letters, digits, dots, dashes. It cannot change later.">
        <TextInput
          className={styles.mono}
          value={draft.username}
          onChange={(event) => onChange({ ...draft, username: event.target.value.toLowerCase() })}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          required
        />
      </Field>
    </>
  );
}

/** The first problem with the account fields, or null; values come back normalized. */
export function checkAccount(
  draft: AccountDraft,
): { problem: string } | { displayName: string; username: string } {
  const displayName = DisplayName.safeParse(draft.displayName);
  if (!displayName.success)
    return { problem: displayName.error.issues[0]?.message ?? "Check the display name." };
  const username = Username.safeParse(draft.username);
  if (!username.success) return { problem: username.error.issues[0]?.message ?? "Check the username." };
  return { displayName: displayName.data, username: username.data };
}
