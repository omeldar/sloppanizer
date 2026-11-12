-- Full text search over todos, notes, comments and people. Trigram tokens find any part of a word
-- (3 characters or more) and remove_diacritics folds umlauts ("muller" finds "Müller").
-- No triggers: the server services keep the index up to date in the same transaction as each change,
-- and rebuild it at every start. Never exported.
CREATE VIRTUAL TABLE `search_fts` USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  todo_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram remove_diacritics 1'
);
