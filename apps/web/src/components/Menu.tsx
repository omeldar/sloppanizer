import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { useKeys } from "../keyboard/KeyboardProvider.tsx";
import styles from "./Menu.module.css";

export interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
}

/** A small action menu under its trigger (topic chips); page shortcuts are off while it is open. */
export function Menu({
  trigger,
  items,
  label,
}: {
  trigger: ReactNode;
  items: readonly MenuItem[];
  label: string;
}) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className={styles.content} align="start" sideOffset={4} aria-label={label}>
          <ModalKeys />
          {items.map((item) => (
            <RadixMenu.Item
              key={item.label}
              className={styles.item}
              data-danger={item.danger || undefined}
              onSelect={item.run}
            >
              {item.label}
            </RadixMenu.Item>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

function ModalKeys() {
  useKeys([], { modal: true });
  return null;
}
