import { parseLabelName } from "@organizer/shared";
import type { CSSProperties } from "react";
import { inkOn } from "../lib/color.ts";
import styles from "./LabelPill.module.css";

interface Props {
  name: string;
  color: string;
  title?: string;
}

/** GitLab style: scoped labels are two part (filled scope, value on the surface); plain labels are filled. */
export function LabelPill({ name, color, title }: Props) {
  const { scope, value } = parseLabelName(name);
  const style = { "--label": color, "--ink": inkOn(color) } as CSSProperties;
  if (scope === null) {
    return (
      <span className={styles.pill} data-kind="plain" style={style} title={title ?? name}>
        <span className={styles.scope}>{value}</span>
      </span>
    );
  }
  return (
    <span className={styles.pill} data-kind="scoped" style={style} title={title ?? name}>
      <span className={styles.scope}>{scope}</span>
      <span className={styles.value}>{value}</span>
    </span>
  );
}
