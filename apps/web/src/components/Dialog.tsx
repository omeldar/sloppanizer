import * as RadixDialog from "@radix-ui/react-dialog";
import type { FormEvent, ReactNode } from "react";
import { useKeys } from "../keyboard/KeyboardProvider.tsx";
import styles from "./Dialog.module.css";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Hidden title for dialogs that show their own heading (palette, pickers). */
  hideTitle?: boolean;
  description?: string;
  width?: number;
  /** Top aligned like a command palette instead of centered. */
  placement?: "center" | "top";
  children: ReactNode;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  hideTitle,
  description,
  width = 520,
  placement = "center",
  children,
}: Props) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={styles.content}
          data-placement={placement}
          style={{ width: `min(${width}px, calc(100vw - 32px))` }}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <ModalKeys />
          <RadixDialog.Title className={hideTitle ? "visually-hidden" : styles.title}>
            {title}
          </RadixDialog.Title>
          {description && (
            <RadixDialog.Description className={styles.description}>{description}</RadixDialog.Description>
          )}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * The padded inside of a dialog under its title: fields, messages and actions in one column.
 * With onSubmit it is the dialog's form.
 */
export function DialogBody({
  children,
  onSubmit,
}: {
  children: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return onSubmit ? (
    <form className={styles.body} onSubmit={onSubmit}>
      {children}
    </form>
  ) : (
    <div className={styles.body}>{children}</div>
  );
}

/** The dialog's buttons, at the end of its body. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}

/** While a dialog is open, page shortcuts are off. */
function ModalKeys() {
  useKeys([], { modal: true });
  return null;
}

export const DialogClose = RadixDialog.Close;
