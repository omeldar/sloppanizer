import type { Meeting } from "@organizer/shared";
import { useState } from "react";
import { Popover } from "../../components/Popover.tsx";
import { PeoplePicker, type PersonChoice } from "../../components/pickers/pickers.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { FieldButton } from "../../components/ui.tsx";
import { errorMessage } from "../../lib/api.ts";
import { useUpdateMeeting } from "../../lib/meetings.ts";
import { PersonChip } from "../people/PersonChip.tsx";
import { personRef } from "../todos/TodoPickerDialog.tsx";
import styles from "./Meetings.module.css";

/** A pick toggles the person: the same id (or, for new names and users, the same name) twice removes them. */
export function togglePerson(current: readonly PersonChoice[], choice: PersonChoice): PersonChoice[] {
  const same = (c: PersonChoice) =>
    "personId" in c && "personId" in choice
      ? c.personId === choice.personId
      : c.displayName.toLowerCase() === choice.displayName.toLowerCase();
  return current.some(same) ? current.filter((c) => !same(c)) : [...current, choice];
}

/**
 * Who is in a meeting: people from the directory, Sloppanizer users, or a new "First Last". Kept in the
 * form until it is saved. Statistics counts the meeting's time for each of them.
 */
export function MeetingPeopleField({
  value,
  onChange,
}: {
  value: readonly PersonChoice[];
  onChange: (next: PersonChoice[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.repeatRow}>
      <span className={styles.label}>People</span>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={
          <FieldButton empty={value.length === 0} aria-label="People: add or remove">
            {value.length === 0 ? "Nobody added" : value.map((p) => p.displayName).join(", ")}
          </FieldButton>
        }
      >
        <PeoplePicker
          label="People"
          value={value}
          onToggle={(choice) => onChange(togglePerson(value, choice))}
        />
      </Popover>
    </div>
  );
}

/**
 * The people section of a meeting's page: chips linking to each person, and a picker that saves each
 * pick right away (on every date of the meeting).
 */
export function MeetingPeople({ meeting }: { meeting: Meeting }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateMeeting();
  const toast = useToast();
  const toggle = (choice: PersonChoice) => {
    const there = "personId" in choice && meeting.people.some((p) => p.id === choice.personId);
    const ref = [personRef(choice)];
    update.mutate(
      { id: meeting.id, patch: there ? { removePeople: ref } : { addPeople: ref } },
      { onError: (failure) => toast.show({ tone: "error", message: errorMessage(failure) }) },
    );
  };
  return (
    <section className={styles.schedule} aria-label="People">
      <h2 className={styles.sectionTitle}>People</h2>
      <div className={styles.peopleRow}>
        {meeting.people.map((person) => (
          <PersonChip key={person.id} person={person} />
        ))}
        <Popover
          open={open}
          onOpenChange={setOpen}
          trigger={
            <FieldButton
              empty={meeting.people.length === 0}
              className={meeting.people.length > 0 ? styles.peopleEdit : undefined}
              aria-label="People: add or remove"
            >
              {meeting.people.length === 0 ? "Nobody added" : "Edit"}
            </FieldButton>
          }
        >
          <PeoplePicker
            label="People"
            value={meeting.people.map((p) => ({ personId: p.id, displayName: p.displayName }))}
            onToggle={toggle}
          />
        </Popover>
      </div>
      <p className={styles.quiet}>Statistics counts the time of this meeting for each of them.</p>
    </section>
  );
}
