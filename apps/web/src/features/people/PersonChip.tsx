import type { PersonBrief } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { HoverCard } from "../../components/HoverCard.tsx";
import { LabelPill } from "../../components/LabelPill.tsx";
import { usePerson } from "../../lib/queries.ts";
import { EmailActions } from "./EmailActions.tsx";
import styles from "./PersonChip.module.css";

/**
 * A person on a todo: name and team, linking to their page. Hovering loads the full person
 * (topics, tags, email with Mail and Copy), which todo payloads leave out on purpose.
 */
export function PersonChip({ person }: { person: PersonBrief }) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard
      onOpenChange={setOpen}
      width={320}
      trigger={
        <Link to="/people/$id" params={{ id: String(person.id) }} className={styles.chip}>
          <span className={styles.name}>{person.displayName}</span>
          {person.team && <span className={styles.team}>{person.team}</span>}
        </Link>
      }
    >
      <PersonCard brief={person} load={open} />
    </HoverCard>
  );
}

function PersonCard({ brief, load }: { brief: PersonBrief; load: boolean }) {
  const person = usePerson(load ? brief.id : 0);
  const full = person.data;
  const email = full?.email ?? brief.email;
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{brief.displayName}</span>
        {(full?.team ?? brief.team) && <span className={styles.cardTeam}>{full?.team ?? brief.team}</span>}
      </div>
      {brief.note && <p className={styles.cardNote}>{brief.note}</p>}
      {full && full.topics.length > 0 && (
        <p className={styles.cardRow}>
          <span className={styles.cardLabel}>Helps with</span> {full.topics.join(", ")}
        </p>
      )}
      {full && full.tags.length > 0 && (
        <span className={styles.cardTags}>
          {full.tags.map((tag) => (
            <LabelPill key={tag.id} name={tag.name} color={tag.color} />
          ))}
        </span>
      )}
      {email && (
        <div className={styles.cardRow}>
          <span className={styles.cardEmail}>{email}</span>
          <EmailActions email={email} />
        </div>
      )}
      {person.isPending && load && <p className={styles.cardNote}>Loading</p>}
    </div>
  );
}
