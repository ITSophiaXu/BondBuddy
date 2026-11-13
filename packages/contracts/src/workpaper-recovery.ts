/** Only these public reasons may influence workpaper conflict copy. */
export const WORKPAPER_CONFLICT_FIELD='workpaper_batch';
export const WORKPAPER_CONFLICT_REASONS=['current_item_active','other_batch_active','source_task_active'] as const;
export type WorkpaperConflictReason=typeof WORKPAPER_CONFLICT_REASONS[number];
export function isWorkpaperConflictReason(value:unknown):value is WorkpaperConflictReason{
  return WORKPAPER_CONFLICT_REASONS.includes(value as WorkpaperConflictReason);
}
/** A queue can stop while its current run still owns the source project. */
export function workpaperItemUnfinished(item:{state:string;run_id:string|null}):boolean{
  return !!item.run_id&&!['succeeded','test_completed','failed','cancelled','rejected'].includes(item.state);
}
