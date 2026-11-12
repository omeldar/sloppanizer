import { Link } from "@tanstack/react-router";
import styles from "./PeopleStats.module.css";

/** Directory and Statistics, the two views of People. */
export function PeopleTabs({ current }: { current: "directory" | "stats" }) {
  return (
    <nav className={styles.viewTabs} aria-label="People views">
      <Link
        to="/people"
        className={styles.viewTab}
        aria-current={current === "directory" ? "page" : undefined}
      >
        Directory
      </Link>
      <Link
        to="/people/stats"
        className={styles.viewTab}
        aria-current={current === "stats" ? "page" : undefined}
      >
        Statistics
      </Link>
    </nav>
  );
}
