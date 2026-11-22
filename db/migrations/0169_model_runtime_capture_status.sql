-- Old nullable values do not prove that the process exited without a signal.
ALTER TABLE bb_model_call_attempt_runtime
 ADD COLUMN exit_capture_status text NOT NULL DEFAULT 'legacy_unknown'
 CHECK(exit_capture_status IN ('legacy_unknown','captured','unavailable'));
ALTER TABLE bb_model_call_attempt_runtime
 ADD COLUMN finish_reason_capture_status text NOT NULL DEFAULT 'legacy_unknown'
 CHECK(finish_reason_capture_status IN ('legacy_unknown','captured','unavailable'));
