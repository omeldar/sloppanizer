import * as RadixHoverCard from "@radix-ui/react-hover-card";
import type { ReactNode } from "react";
import styles from "./HoverCard.module.css";

interface Props {
  trigger: ReactNode;
  children: ReactNode;
  /** Called when the card opens, e.g. to start loading what it shows. */
  onOpenChange?: (open: boolean) => void;
  width?: number;
}

/** A small read-only card on hover or keyboard focus (todo refs, contact chips). */
export function HoverCard({ trigger, children, onOpenChange, width = 300 }: Props) {
  return (
    <RadixHoverCard.Root openDelay={350} closeDelay={120} onOpenChange={onOpenChange}>
      <RadixHoverCard.Trigger asChild>{trigger}</RadixHoverCard.Trigger>
      <RadixHoverCard.Portal>
        <RadixHoverCard.Content
          className={styles.content}
          style={{ width }}
          sideOffset={6}
          collisionPadding={12}
          align="start"
        >
          {children}
        </RadixHoverCard.Content>
      </RadixHoverCard.Portal>
    </RadixHoverCard.Root>
  );
}
