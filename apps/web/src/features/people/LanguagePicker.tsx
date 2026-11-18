import { LANGUAGE_LABELS, PERSON_LANGUAGES, type PersonLanguage, sortLanguages } from "@organizer/shared";
import styles from "./People.module.css";

/** The languages with this one switched on or off, in the fixed order (German, English). */
export function toggleLanguage(languages: readonly PersonLanguage[], code: PersonLanguage): PersonLanguage[] {
  return languages.includes(code) ? languages.filter((l) => l !== code) : sortLanguages([...languages, code]);
}

/** German and English as on/off buttons: one, both or none. */
export function LanguagePicker({
  value,
  onChange,
  labelledBy,
}: {
  value: readonly PersonLanguage[];
  onChange: (languages: PersonLanguage[]) => void;
  /** Id of the visible "Languages" label; without one the group is named "Languages". */
  labelledBy?: string;
}) {
  return (
    <div
      className={styles.languages}
      role="group"
      {...(labelledBy ? { "aria-labelledby": labelledBy } : { "aria-label": "Languages" })}
    >
      {PERSON_LANGUAGES.map((code) => (
        <button
          key={code}
          type="button"
          className={styles.language}
          aria-pressed={value.includes(code)}
          onClick={() => onChange(toggleLanguage(value, code))}
        >
          {LANGUAGE_LABELS[code]}
        </button>
      ))}
    </div>
  );
}
