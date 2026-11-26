import { PROJECT_COLORS, type Space } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { useCurrentAccount } from "../../app/account.tsx";
import { Dialog, DialogActions, DialogBody } from "../../components/Dialog.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { absoluteDate } from "../../lib/format.ts";
import { useUsers } from "../../lib/queries.ts";
import {
  spaceHref,
  useAddSpaceMember,
  useCreateSpace,
  useDeleteSpace,
  useRemoveSpaceMember,
  useUpdateSpace,
} from "../../lib/spaces.ts";
import { ColorChoice } from "../projects/NewProjectDialog.tsx";
import styles from "./Spaces.module.css";

const splitNames = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((name) => name.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);

/** A new shared project: a name, a color and the usernames to invite. */
export function NewSpaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New shared project"
      description="A project you and others work on together: the same todos, board, planner and notes."
      width={460}
    >
      {open && <NewSpaceForm onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function NewSpaceForm({ onDone }: { onDone: () => void }) {
  const create = useCreateSpace();
  const account = useCurrentAccount();
  const [name, setName] = useState("");
  const [members, setMembers] = useState("");
  const [color, setColor] = useState<string>(PROJECT_COLORS[2]);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const space = await create.mutateAsync({
        name: name.trim(),
        color: color as (typeof PROJECT_COLORS)[number],
        members: splitNames(members),
      });
      onDone();
      if (account) window.location.assign(spaceHref(account.username, space));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <DialogBody onSubmit={submit}>
      <Field label="Name">
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Team offsite"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opens to type a name
          autoFocus
          required
          maxLength={100}
        />
      </Field>
      <Field
        label="Members"
        hint="Usernames, separated by commas or spaces. They get access right away; you can add more later."
      >
        <TextInput value={members} onChange={(e) => setMembers(e.target.value)} placeholder="bo, carla" />
      </Field>
      <ColorChoice value={color} onChange={setColor} />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
          Create shared project
        </Button>
      </DialogActions>
    </DialogBody>
  );
}

/** What adding people did, in words: who is in now, who already was. */
export function addedMessage(
  projectName: string,
  fresh: readonly string[],
  already: readonly string[],
  space: Pick<Space, "members">,
): string {
  const named = fresh.map((one) => {
    const member = space.members.find((m) => m.username === one);
    return member && member.name !== member.username ? `${member.name} (@${one})` : `@${one}`;
  });
  return [
    named.length > 0 ? `Added ${named.join(", ")}. ${projectName} is under Shared in their sidebar now.` : "",
    already.length > 0
      ? `${already.map((one) => `@${one}`).join(", ")} already ${already.length === 1 ? "has" : "have"} access.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Members of a shared project: owners add and remove them, rename or delete it; members can leave. */
export function SpaceDialog({
  space,
  onOpenChange,
}: {
  space: Space | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={space !== null}
      onOpenChange={onOpenChange}
      title={space ? `Share ${space.name}` : "Shared project"}
      description={
        space?.system === "feedback"
          ? "Bug reports and feature requests from every user. Every admin is a member."
          : "Who has access. There are no invitations to accept: people you add are in right away."
      }
      width={480}
    >
      {space && <SpaceForm space={space} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function SpaceForm({ space, onDone }: { space: Space; onDone: () => void }) {
  const account = useCurrentAccount();
  const toast = useToast();
  const update = useUpdateSpace(space.id);
  const add = useAddSpaceMember(space.id);
  const remove = useRemoveSpaceMember(space.id);
  const del = useDeleteSpace(space.id);
  const owner = space.role === "owner";
  const system = space.system !== null;
  const [name, setName] = useState(space.name);
  const [color, setColor] = useState(space.color);
  const [username, setUsername] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const query = username.trim().replace(/^@/, "");
  const users = useUsers(owner && !system && /^[^\s,;]+$/.test(query) ? query : "");
  const suggestions = (users.data ?? []).filter(
    (user) => !space.members.some((m) => m.username === user.username),
  );

  const attempt = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const changed = {
      ...(name.trim() !== space.name && !system ? { name: name.trim() } : {}),
      ...(color !== space.color ? { color: color as (typeof PROJECT_COLORS)[number] } : {}),
    };
    if (Object.keys(changed).length === 0) return onDone();
    if (await attempt(() => update.mutateAsync(changed))) onDone();
  };

  const addMember = async (names = splitNames(username)) => {
    if (names.length === 0) return;
    setAdded(null);
    const known = new Set(space.members.map((m) => m.username));
    const already = names.filter((one) => known.has(one));
    const fresh = names.filter((one) => !known.has(one));
    let latest: Space = space;
    const ok = await attempt(async () => {
      // One at a time: each answer is the whole member list. An unknown name stops here with its error.
      // oxlint-disable-next-line no-await-in-loop -- in order, so the last answer has every member
      for (const one of fresh) latest = await add.mutateAsync(one);
    });
    if (!ok) return;
    setUsername("");
    setAdded(addedMessage(space.name, fresh, already, latest));
  };

  return (
    <DialogBody {...(owner ? { onSubmit: save } : {})}>
      {owner && !system && (
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
      )}
      {owner && <ColorChoice value={color} onChange={setColor} />}
      <Field label={`People with access (${space.members.length})`}>
        <ul className={styles.members} aria-label="People with access">
          {space.members.map((member) => {
            const you = member.accountId === account?.accountId;
            return (
              <li key={member.accountId} className={styles.member}>
                <span className={styles.memberName}>
                  {member.name}
                  {you && " (you)"} <span className={styles.memberUser}>@{member.username}</span>
                  {member.addedAt && (
                    <span className={styles.memberSince}>since {absoluteDate(member.addedAt)}</span>
                  )}
                </span>
                <span className={styles.role}>
                  {system ? "Admin" : member.role === "owner" ? "Owner" : "Member"}
                </span>
                {!system && owner && !you && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setAdded(null);
                      void attempt(() => remove.mutateAsync(member.accountId)).then(
                        (done) =>
                          done && setAdded(`Removed @${member.username}. They no longer have access.`),
                      );
                    }}
                    aria-label={`Remove ${member.username}`}
                  >
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Field>
      {owner && !system && (
        <>
          <div className={styles.addRow}>
            <TextInput
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addMember();
                }
              }}
              placeholder="Username to add"
              aria-label="Username to add"
            />
            <Button onClick={() => void addMember()} disabled={!username.trim() || add.isPending}>
              Add
            </Button>
          </div>
          {suggestions.length > 0 && (
            <ul className={styles.suggestions} aria-label="Matching users">
              {suggestions.map((user) => (
                <li key={user.username}>
                  <button
                    type="button"
                    className={styles.suggestion}
                    onClick={() => void addMember([user.username])}
                  >
                    {user.name} <span className={styles.memberUser}>@{user.username}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {added && (
        <p className={styles.note} role="status">
          {added}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!system && (
        <div className={styles.danger}>
          {account && (
            <Button
              variant="ghost"
              onClick={async () => {
                if (!(await attempt(() => remove.mutateAsync(account.accountId)))) return;
                toast.show({ message: `You left ${space.name}` });
                onDone();
              }}
            >
              Leave
            </Button>
          )}
          {owner &&
            (confirmDelete ? (
              <Button
                variant="danger"
                onClick={async () => {
                  if (!(await attempt(() => del.mutateAsync()))) return;
                  toast.show({ message: `Deleted ${space.name}` });
                  onDone();
                }}
              >
                Delete it and all its todos
              </Button>
            ) : (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ))}
        </div>
      )}
      {owner && (
        <DialogActions>
          <Button type="submit" variant="primary" disabled={update.isPending}>
            Save
          </Button>
        </DialogActions>
      )}
    </DialogBody>
  );
}
