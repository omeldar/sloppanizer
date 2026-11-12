import type { Person } from "@organizer/shared";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCommands } from "../../app/commands.tsx";
import { LabelPill } from "../../components/LabelPill.tsx";
import { Popover } from "../../components/Popover.tsx";
import { Picker } from "../../components/pickers/Picker.tsx";
import {
  Button,
  EmptyState,
  ErrorState,
  FieldButton,
  Loading,
  PageHeader,
  TextInput,
} from "../../components/ui.tsx";
import { type KeyBinding, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { type PeopleParams, usePeople, usePersonTags, useTeams } from "../../lib/queries.ts";
import { useUrlText } from "../../lib/useUrlText.ts";
import styles from "./People.module.css";
import { PeopleTabs } from "./PeopleTabs.tsx";
import { TopicInput } from "./TopicInput.tsx";

const route = getRouteApi("/people");

export interface PeopleSearch {
  q?: string;
  /** Comma list of topic names (all must match). */
  topic?: string;
  team?: string;
  /** Comma list of person tag names (all must match). */
  tag?: string;
  kind?: "requester" | "contact";
  sort?: "name" | "requested" | "contact" | "recent";
}

const SORTS = { name: "Name", requested: "Most requested", contact: "Most asked", recent: "Recently linked" };
const TABS = [
  { kind: undefined, label: "All" },
  { kind: "requester", label: "Requesters" },
  { kind: "contact", label: "Contacts" },
] as const;

export function splitList(value: string | undefined): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

export function joinList(values: readonly string[]): string | undefined {
  return values.length > 0 ? values.join(",") : undefined;
}

/** URL search -> API query; the URL keeps lists as comma text. */
export function peopleParams(search: PeopleSearch): PeopleParams {
  return {
    q: search.q?.trim() || undefined,
    topic: splitList(search.topic),
    team: search.team,
    tag: splitList(search.tag),
    kind: search.kind,
    sort: search.sort,
  };
}

export function PeoplePage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const { openNewPerson } = useCommands();
  const people = usePeople(peopleParams(search));
  const list = people.data ?? [];
  const set = (patch: Partial<PeopleSearch>) =>
    void navigate({ to: "/people", search: { ...search, ...patch }, replace: true });
  const filtered = Boolean(search.q || search.topic || search.team || search.tag || search.kind);
  // The list asks the server once typing pauses, not on every key.
  const filter = useUrlText(search.q ?? "", (q) => set({ q: q || undefined }));

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const index = list.findIndex((p) => p.id === selectedId);
  const move = (delta: number) => {
    if (list.length === 0) return;
    const next = index === -1 ? (delta > 0 ? 0 : list.length - 1) : index + delta;
    setSelectedId(list[Math.max(0, Math.min(list.length - 1, next))]?.id ?? null);
  };
  const bindings: KeyBinding[] = [
    { keys: "j", run: () => move(1), label: "Next person", group: "People" },
    { keys: "k", run: () => move(-1), label: "Previous person", group: "People" },
    { keys: "ArrowDown", run: () => move(1) },
    { keys: "ArrowUp", run: () => move(-1) },
    {
      keys: "Enter",
      run: () =>
        selectedId !== null && void navigate({ to: "/people/$id", params: { id: String(selectedId) } }),
      label: "Open person",
      group: "People",
    },
    { keys: "f", run: () => filterRef.current?.focus(), label: "Search people", group: "People" },
  ];
  useKeys(bindings);

  return (
    <div className={styles.page}>
      <PageHeader
        title="People and contacts"
        meta={people.data ? `${list.length} ${list.length === 1 ? "person" : "people"}` : undefined}
        actions={
          <Button variant="primary" onClick={() => openNewPerson()}>
            New person
          </Button>
        }
      />
      <PeopleTabs current="directory" />
      <div className={styles.toolbar}>
        <div className={styles.tabs} role="group" aria-label="Show">
          {TABS.map((tab) => (
            <button
              key={tab.label}
              type="button"
              className={styles.tab}
              aria-pressed={search.kind === tab.kind}
              onClick={() => set({ kind: tab.kind })}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <TextInput
          ref={filterRef}
          className={styles.search}
          value={filter.text}
          onChange={(e) => filter.setText(e.target.value)}
          placeholder="Name, team, email or topic"
          aria-label="Search people"
        />
        <TeamFilter value={search.team} onChange={(team) => set({ team })} />
        <TagFilter value={splitList(search.tag)} onChange={(tags) => set({ tag: joinList(tags) })} />
        <label className={styles.sort}>
          <span>Sort</span>
          <select
            className={styles.select}
            value={search.sort ?? "name"}
            onChange={(e) =>
              set({ sort: e.target.value === "name" ? undefined : (e.target.value as PeopleSearch["sort"]) })
            }
          >
            {Object.entries(SORTS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.topicFilter}>
        <span className={styles.filterLabel}>Topics</span>
        <TopicInput
          topics={splitList(search.topic)}
          placeholder="Who helps with ..."
          onAdd={(name) => set({ topic: joinList([...splitList(search.topic), name]) })}
          onRemove={(name) => set({ topic: joinList(splitList(search.topic).filter((t) => t !== name)) })}
        />
      </div>

      {people.isPending && <Loading />}
      {people.isError && <ErrorState error={people.error} onRetry={() => void people.refetch()} />}
      {people.data && list.length === 0 && (
        <EmptyState>
          {filtered ? (
            <>
              Nobody matches these filters. Remove a topic or tag, pick All, or{" "}
              <Link to="/people">clear every filter</Link>.
            </>
          ) : (
            "No people yet. Choose New person, or type a name in the Requested by field of a todo."
          )}
        </EmptyState>
      )}
      {list.length > 0 && (
        <ol className={styles.bay} aria-label="People">
          <li className={styles.header} aria-hidden="true">
            <span>Name</span>
            <span>Team</span>
            <span>Topics and tags</span>
            <span className={styles.num}>Requested</span>
            <span className={styles.num}>Open</span>
            <span className={styles.num}>Done</span>
            <span className={styles.num}>Contact for</span>
          </li>
          {list.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              selected={person.id === selectedId}
              onSelect={() => setSelectedId(person.id)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function PersonRow({
  person,
  selected,
  onSelect,
}: {
  person: Person;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const { counts } = person;
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a click moves the list cursor (j/k do the same by keyboard)
    <li ref={ref} className={styles.row} data-selected={selected || undefined} onMouseDown={onSelect}>
      <span className={styles.nameCell}>
        <Link to="/people/$id" params={{ id: String(person.id) }} className={styles.name}>
          {person.displayName}
        </Link>
        {person.note && <span className={styles.note}>{person.note}</span>}
      </span>
      <span className={styles.team}>{person.team}</span>
      <span className={styles.pills}>
        {person.topics.map((topic) => (
          <span key={topic} className={styles.topic}>
            {topic}
          </span>
        ))}
        {person.tags.map((tag) => (
          <LabelPill key={tag.id} name={tag.name} color={tag.color} title={tag.description || tag.name} />
        ))}
      </span>
      <span className={styles.num}>{counts.requested}</span>
      <span className={styles.num}>{counts.requestedOpen}</span>
      <span className={styles.num}>{counts.requestedDone}</span>
      <span className={styles.num}>{counts.contact}</span>
    </li>
  );
}

export function TeamFilter({
  value,
  onChange,
}: {
  value?: string;
  onChange: (team: string | undefined) => void;
}) {
  const teams = useTeams();
  return (
    <label className={styles.sort}>
      <span>Team</span>
      <select
        className={styles.select}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">Any team</option>
        {(teams.data ?? []).map((team) => (
          <option key={team.name} value={team.name}>
            {team.name}
          </option>
        ))}
        {value && !teams.data?.some((t) => t.name.toLowerCase() === value.toLowerCase()) && (
          <option value={value}>{value}</option>
        )}
      </select>
    </label>
  );
}

export function TagFilter({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const tags = usePersonTags();
  const [open, setOpen] = useState(false);
  const selected = new Set(value.map((v) => v.toLowerCase()));
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <FieldButton empty={value.length === 0} className={styles.tagButton}>
          {value.length === 0 ? "Any tag" : value.join(", ")}
        </FieldButton>
      }
    >
      <Picker
        label="Person tags"
        placeholder="Filter by tags (all must match)"
        items={(tags.data ?? []).map((tag) => ({
          value: tag.name.toLowerCase(),
          search: tag.name,
          label: <LabelPill name={tag.name} color={tag.color} />,
          note: String(tag.peopleCount),
        }))}
        selected={selected}
        onPick={(lower) => {
          const tag = tags.data?.find((t) => t.name.toLowerCase() === lower);
          if (!tag) return;
          onChange(
            selected.has(lower) ? value.filter((v) => v.toLowerCase() !== lower) : [...value, tag.name],
          );
        }}
        empty="No person tags yet. Create them on the Labels page or a person's page."
      />
    </Popover>
  );
}
