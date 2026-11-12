-- Step 1 recorded people_changed events for requesters only and without a role. From now on the data is
-- { role, from, to }, so old events get role "requester".
UPDATE `events` SET `data` = json_set(`data`, '$.role', 'requester')
  WHERE `kind` = 'people_changed' AND json_extract(`data`, '$.role') IS NULL;
