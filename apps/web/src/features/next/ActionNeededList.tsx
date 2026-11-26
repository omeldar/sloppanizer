import { StripList } from "../../components/strip/StripList.tsx";
import stripStyles from "../../components/strip/Strip.module.css";
import { useTodos } from "../../lib/queries.ts";

/**
 * Next up: your open todos marked "action needed" (by an assistant's run, a script or yourself), before
 * the ranking, so what waits on you is seen first. Gone when nothing is marked.
 */
export function ActionNeededList() {
  const marked = useTodos({ actionNeeded: "true", sort: "updated", order: "desc", limit: 50 });
  const items = (marked.data?.items ?? []).filter((todo) => todo.actionNeeded !== null);
  if (items.length === 0) return null;
  return (
    <section className={stripStyles.groupLead} aria-label="Action needed">
      <h2 className={stripStyles.groupTitle}>
        Action needed <span className={stripStyles.groupCount}>{items.length}</span>
      </h2>
      <StripList items={items.map((todo) => ({ todo }))} label="Todos that need you to act" keys={false} />
    </section>
  );
}
