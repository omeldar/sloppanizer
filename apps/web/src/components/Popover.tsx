import * as RadixPopover from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { useKeys } from "../keyboard/KeyboardProvider.tsx";
import styles from "./Popover.module.css";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
}

/** A menu panel under its trigger; page shortcuts are off while it is open. */
export function Popover({ open, onOpenChange, trigger, children, align = "start" }: Props) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className={styles.content} align={align} sideOffset={4} collisionPadding={12}>
          <ModalKeys />
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

function ModalKeys() {
  useKeys([], { modal: true });
  return null;
}
