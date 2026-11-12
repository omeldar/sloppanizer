import { mailtoUrl, teamsChatUrl } from "@organizer/shared";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import styles from "./People.module.css";

/** Mail, Teams chat and Copy for a person's address. */
export function EmailActions({ email }: { email: string }) {
  const toast = useToast();
  return (
    <span className={styles.emailActions}>
      <a href={mailtoUrl(email)} className={styles.action}>
        Mail
      </a>
      <a href={teamsChatUrl(email)} target="_blank" rel="noreferrer noopener" className={styles.action}>
        Teams chat
      </a>
      <button
        type="button"
        className={styles.action}
        onClick={() =>
          void navigator.clipboard
            .writeText(email)
            .then(() => toast.show({ message: `Copied ${email}` }))
            .catch(() =>
              toast.show({
                tone: "error",
                message: "Could not copy. Select the address and copy it by hand.",
              }),
            )
        }
      >
        Copy
      </button>
    </span>
  );
}
