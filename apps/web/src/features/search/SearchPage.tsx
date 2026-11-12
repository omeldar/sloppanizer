import { STATUS_LABELS, type SearchHit, type SearchKind } from "@organizer/shared";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { EmptyState, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { type KeyBinding, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { useSearch } from "../../lib/queries.ts";
import { useDebounced } from "../../lib/useDebounced.ts";
import { Highlighted, hitTarget, KIND_NAMES, KIND_ORDER, KIND_SINGULAR } from "./hits.tsx";
import styles from "./Search.module.css";

const route = getRouteApi("/search");

export interface SearchPageSearch {
  q?: string;
  kind?: SearchKind;
}

export function SearchPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const [text, setText] = useState(search.q ?? "");
  const q = useDebounced(text.trim(), 150);
  const input = useRef<HTMLInputElement>(null);
  const result = useSearch(
    { q, kinds: search.kind ? [search.kind] : undefined, limit: search.kind ? 100 : 20 },
    q.length > 0,
  );
  const items = result.data?.items ?? [];

  // The URL follows the typed text, so a search can be shared or reloaded.
  useEffect(() => {
    if ((search.q ?? "") !== q)
      void navigate({ to: "/search", search: { ...search, q: q || undefined }, replace: true });
  }, [q, search, navigate]);

  useEffect(() => input.current?.focus(), []);

  const [selected, setSelected] = useState(-1);
  useEffect(() => setSelected(-1), [q, search.kind]);
  const open = (hit: SearchHit) => {
    const target = hitTarget(hit);
    void navigate({ to: target.to, params: target.params, search: target.search });
  };
  const move = (delta: number) => {
    if (items.length === 0) return;
    setSelected((i) =>
      i === -1 ? (delta > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + delta)),
    );
  };
  const bindings: KeyBinding[] = [
    { keys: "j", run: () => move(1), label: "Next result", group: "Search" },
    { keys: "k", run: () => move(-1), label: "Previous result", group: "Search" },
    { keys: "ArrowDown", run: () => move(1), whileTyping: true },
    { keys: "ArrowUp", run: () => move(-1), whileTyping: true },
    {
      keys: "Enter",
      run: () => {
        const hit = items[selected === -1 ? 0 : selected];
        if (hit) open(hit);
      },
      label: "Open result",
      group: "Search",
      whileTyping: true,
    },
    { keys: "f", run: () => input.current?.focus(), label: "Edit the search", group: "Search" },
  ];
  useKeys(bindings);

  const counts = result.data?.counts;
  const total = counts ? KIND_ORDER.reduce((sum, kind) => sum + counts[kind], 0) : 0;

  return (
    <div className={styles.page}>
      <PageHeader title="Search" />
      <input
        ref={input}
        className={styles.input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Todos, notes, comments and people. Umlauts and case do not matter."
        aria-label="Search"
        maxLength={200}
      />
      <div className={styles.tabs} role="tablist" aria-label="Kinds">
        <Tab
          label="All"
          count={q ? total : undefined}
          active={!search.kind}
          onClick={() => setKind(undefined)}
        />
        {KIND_ORDER.map((kind) => (
          <Tab
            key={kind}
            label={KIND_NAMES[kind]}
            count={q ? counts?.[kind] : undefined}
            active={search.kind === kind}
            onClick={() => setKind(kind)}
          />
        ))}
      </div>
      {!q && (
        <EmptyState>Type to search. Press / anywhere to come here, ctrl+k for the quick search.</EmptyState>
      )}
      {q && result.isPending && <Loading />}
      {result.isError && <ErrorState error={result.error} onRetry={() => void result.refetch()} />}
      {q && result.data && items.length === 0 && (
        <EmptyState>
          Nothing found for "{q}". Try fewer or shorter words{search.kind ? ", or search in All" : ""}.
        </EmptyState>
      )}
      {items.length > 0 && (
        <ol className={styles.results} aria-label="Results">
          {items.map((hit, i) => (
            <Result
              key={`${hit.kind}-${hit.id}`}
              hit={hit}
              selected={i === selected}
              showKind={!search.kind}
            />
          ))}
        </ol>
      )}
    </div>
  );

  function setKind(kind: SearchKind | undefined) {
    void navigate({ to: "/search", search: { q: q || undefined, kind }, replace: true });
  }
}

function Tab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" role="tab" aria-selected={active} className={styles.tab} onClick={onClick}>
      {label}
      {count !== undefined && <span className={styles.tabCount}>{count}</span>}
    </button>
  );
}

function Result({ hit, selected, showKind }: { hit: SearchHit; selected: boolean; showKind: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const target = hitTarget(hit);
  return (
    <li ref={ref} className={styles.result} data-selected={selected || undefined} data-kind={hit.kind}>
      <Link to={target.to} params={target.params} search={target.search} className={styles.resultLink}>
        <span className={styles.resultTop}>
          {showKind && <span className={styles.kind}>{KIND_SINGULAR[hit.kind]}</span>}
          {hit.kind === "todo" && <span className={styles.id}>#{hit.id}</span>}
          <span className={styles.title}>{hit.title}</span>
          {hit.status && (
            <span className={styles.status} data-status={hit.status}>
              {STATUS_LABELS[hit.status]}
            </span>
          )}
          {hit.subtitle && <span className={styles.subtitle}>{hit.subtitle}</span>}
        </span>
        {hit.snippet && (
          <span className={styles.snippet}>
            <Highlighted text={hit.snippet} ranges={hit.highlights} />
          </span>
        )}
      </Link>
    </li>
  );
}
