import { useCommands } from "../../app/commands.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Kbd } from "../../components/ui.tsx";
import type { KeyBinding } from "../../keyboard/KeyboardProvider.tsx";
import styles from "./HelpOverlay.module.css";

/** Lists the shortcuts that were active when ? was pressed, by group. */
export function HelpOverlay({ bindings }: { bindings: readonly KeyBinding[] }) {
  const { help, close } = useCommands();
  const groups = new Map<string, KeyBinding[]>();
  for (const binding of bindings) {
    if (!binding.label) continue;
    const group = binding.group ?? "Other";
    groups.set(group, [...(groups.get(group) ?? []), binding]);
  }

  return (
    <Dialog
      open={help}
      onOpenChange={(open) => !open && close("help")}
      title="Keyboard shortcuts"
      description="Single keys work in normal mode. While you type in a field (insert mode) they are off; Esc leaves the field."
      width={640}
    >
      <div className={styles.grid}>
        {[...groups].map(([group, list]) => (
          <section key={group} className={styles.group}>
            <h2 className={styles.heading}>{group}</h2>
            <dl className={styles.list}>
              {list.map((binding) => (
                <div key={binding.keys} className={styles.row}>
                  <dt>
                    <Kbd keys={binding.keys} />
                  </dt>
                  <dd>{binding.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
