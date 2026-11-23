ALTER TABLE bb_model_capacity_holders
 DROP CONSTRAINT bb_model_capacity_holders_slot_check;
ALTER TABLE bb_model_capacity_holders
 ADD CONSTRAINT bb_model_capacity_holders_slot_check CHECK(slot BETWEEN 1 AND 6);
