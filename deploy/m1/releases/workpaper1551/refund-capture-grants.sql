GRANT INSERT(owner_user_id,reservation_id,item_id,run_id,ordinal,source_item_key,
             label,points,scope_quote_id,evidence_kind,evidence)
 ON public.bb_task_refund_units TO :"runtime_role";
GRANT INSERT(reservation_id,item_id,origin_lot_id,points)
 ON public.bb_task_refund_unit_slices TO :"runtime_role";
