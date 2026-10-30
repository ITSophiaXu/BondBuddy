-- Source-format intermediates and diagnostics use owned run directories.
-- This only enables the resumable inventory cursor; automatic inventory deletion
-- remains limited to legacy prompt snapshots. Project deletion owns their purge.
ALTER TABLE bb_storage_inventory_cursors DROP CONSTRAINT bb_storage_inventory_cursors_prefix_check;
ALTER TABLE bb_storage_inventory_cursors ADD CONSTRAINT bb_storage_inventory_cursors_prefix_check
  CHECK (prefix IN ('users/','parse-cache/','log-archive/','owners/'));
