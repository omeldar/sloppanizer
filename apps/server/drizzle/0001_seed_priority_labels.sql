-- Priority labels every install starts with. Seeded once; the user may change or delete them later.
INSERT OR IGNORE INTO `labels` (`name`, `scope`, `value`, `color`, `description`, `rank`, `created_at`, `updated_at`) VALUES
  ('priority::critical', 'priority', 'critical', '#F2555A', '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('priority::high', 'priority', 'high', '#FFB224', '', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('priority::medium', 'priority', 'medium', '#9AA4B2', '', 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('priority::low', 'priority', 'low', '#5B6573', '', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
