// Conventional commits. The subject may contain proper nouns (SQLite, MCP),
// it just must not start with a capital.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]],
    "header-max-length": [2, "always", 72],
  },
};
