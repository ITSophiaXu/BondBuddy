// The caller owns BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY / ROLLBACK.
// This query deliberately retains absent entities; the assertion layer rejects them.
export const BILLING_SNAPSHOT_SQL = `
WITH scope_runs AS (
 SELECT unnest($2::text[]) AS run_id
 UNION SELECT run_id FROM bb_workpaper_attempts WHERE owner_user_id=$1 AND batch_id=$3
), owned_reservations AS (
 SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1
), scoped_reservations AS (
 SELECT c.* FROM owned_reservations c JOIN scope_runs s ON s.run_id=c.run_id
), quote_rows AS (
 SELECT q.id,q.owner_user_id,q.project_id,NULL::text AS run_id,q.input_hash::text,
 q.points::text,q.price_version,q.scope_quote_id,'fixed'::text AS source
 FROM bb_credit_quotes q JOIN scoped_reservations c ON c.quote_id=q.id AND c.owner_user_id=q.owner_user_id
 UNION ALL
 SELECT q.id,q.owner_user_id,t.project_id,NULL::text,q.intent_hash::text,
 q.reserve_points::text,q.fixed_price_version,q.scope_quote_id,'m4'
 FROM bb_m4_quotes q JOIN scoped_reservations c ON c.quote_id=q.id AND c.owner_user_id=q.owner_user_id
 JOIN bb_m4_topics t ON t.id=q.topic_id AND t.owner_user_id=q.owner_user_id
 UNION ALL
 SELECT q.id,q.owner_user_id,r.project_id,q.run_id,q.input_hash::text,
 q.points::text,q.price_version,q.scope_quote_id,'qa'
 FROM bb_project_qa_quotes q JOIN scoped_reservations c ON c.quote_id=q.id AND c.owner_user_id=q.owner_user_id
 JOIN bb_runs r ON r.id=q.run_id AND r.owner_user_id=q.owner_user_id
 UNION ALL
 SELECT q.id,q.owner_user_id,r.project_id,q.run_id,q.input_hash::text,
 q.points::text,q.price_version,q.scope_quote_id,'integrity'
 FROM bb_integrity_quotes q JOIN scoped_reservations c ON c.quote_id=q.id AND c.owner_user_id=q.owner_user_id
 JOIN bb_runs r ON r.id=q.run_id AND r.owner_user_id=q.owner_user_id
), packages AS (
 SELECT * FROM bb_file_generation_batches WHERE owner_user_id=$1 AND workpaper_batch_id=$3
)
SELECT jsonb_build_object(
 'owner_id',$1::text,
 'transaction_read_only',current_setting('transaction_read_only'),
 'transaction_isolation',current_setting('transaction_isolation'),
 'captured_at',transaction_timestamp(),
 'scope_run_ids',COALESCE((SELECT jsonb_agg(run_id ORDER BY run_id) FROM scope_runs),'[]'),
 'runs',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'owner_user_id',r.owner_user_id,
   'project_id',r.project_id,'state',r.state,'billing_mode',r.billing_mode,'reservation_id',r.reservation_id,
   'input_hash',trim(r.input_hash)) ORDER BY r.id)
   FROM bb_runs r JOIN scope_runs s ON s.run_id=r.id WHERE r.owner_user_id=$1),'[]'),
 'reservations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'owner_user_id',c.owner_user_id,
   'run_id',c.run_id,'quote_id',c.quote_id,'points',c.points::text,'charged_points',c.charged_points::text,
   'state',c.state,'billing_policy',c.billing_policy,'created_at',c.created_at,'finalized_at',c.finalized_at) ORDER BY c.id)
   FROM owned_reservations c),'[]'),
 'quotes',COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM quote_rows q),'[]'),
 'scope_quotes',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'owner_user_id',q.owner_user_id,
   'project_id',q.project_id,'price_version',q.price_version,'points',q.amount_fen::text,'input_hash',trim(q.input_hash),
   'status',q.status,'snapshot',q.snapshot) ORDER BY q.id)
   FROM bb_scope_quotations q WHERE q.owner_user_id=$1 AND q.id IN (SELECT scope_quote_id FROM quote_rows)),'[]'),
 'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'owner_user_id',e.owner_user_id,
   'event_key',e.event_key,'kind',e.kind,'points',e.points::text,'reservation_id',e.reservation_id,
   'lot_id',e.lot_id,'run_id',e.run_id,'created_at',e.created_at) ORDER BY e.id)
   FROM bb_credit_events e WHERE e.owner_user_id=$1),'[]'),
 'allocations',COALESCE((SELECT jsonb_agg(jsonb_build_object('reservation_id',a.reservation_id,
   'lot_id',a.lot_id,'points',a.points::text,'charged_points',a.charged_points::text) ORDER BY a.reservation_id,a.lot_id)
   FROM bb_credit_allocations a JOIN owned_reservations c ON c.id=a.reservation_id),'[]'),
 'lots',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'owner_user_id',l.owner_user_id,
   'source',l.source,'source_key',l.source_key,'original_points',l.original_points::text,
   'remaining',l.remaining::text,'frozen',l.frozen::text,'expires_at',l.expires_at,
   'is_expired',COALESCE(l.expires_at<=transaction_timestamp(),false)) ORDER BY l.id)
   FROM bb_credit_lots l WHERE l.owner_user_id=$1),'[]'),
 'workpaper',jsonb_build_object(
   'batch',(SELECT jsonb_build_object('id',b.id,'owner_user_id',b.owner_user_id,'project_id',b.project_id,
     'state',b.state,'total_points',b.total_points::text,'price_version',b.price_version,'request_id',b.request_id)
     FROM bb_workpaper_batches b WHERE b.owner_user_id=$1 AND b.id=$3),
   'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('item_id',i.item_id,'run_id',i.run_id,
     'attempt',i.attempt,'state',i.state) ORDER BY i.ordinal)
     FROM bb_workpaper_items i WHERE i.owner_user_id=$1 AND i.batch_id=$3),'[]'),
   'attempts',COALESCE((SELECT jsonb_agg(jsonb_build_object('item_id',a.item_id,'run_id',a.run_id,
     'attempt',a.attempt) ORDER BY a.item_id,a.attempt)
     FROM bb_workpaper_attempts a WHERE a.owner_user_id=$1 AND a.batch_id=$3),'[]'),
   'results',COALESCE((SELECT jsonb_agg(jsonb_build_object('run_id',r.run_id,'item_id',r.item_id,
     'decision',r.decision,'explanation',r.explanation,'result_hash',r.result_hash) ORDER BY r.run_id)
     FROM bb_workpaper_item_results r WHERE r.owner_user_id=$1 AND r.batch_id=$3),'[]'),
   'packages',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'owner_user_id',p.owner_user_id,
     'project_id',p.project_id,'request_id',p.request_id,'request_hash',trim(p.request_hash),'points',p.points::text,
     'workpaper_batch_id',p.workpaper_batch_id,'document_batch_id',p.document_batch_id,
     'price_version',p.snapshot->'quote'->>'price_version','quote_id',p.snapshot->'quote'->>'quote_id',
     'quote_points',p.snapshot->'quote'->>'points','item_ids',p.snapshot->'preparation'->'item_ids') ORDER BY p.id)
     FROM packages p),'[]'),
   'package_quotes',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'owner_user_id',q.owner_user_id,
     'project_id',q.project_id,'accepted_batch_id',q.accepted_batch_id,'price_version',q.price_version,
     'points',q.quote->>'points') ORDER BY q.id)
     FROM bb_file_generation_quotes q WHERE q.owner_user_id=$1 AND q.accepted_batch_id IN (SELECT id FROM packages)),'[]')
 ),
 'integrity',COALESCE((SELECT jsonb_agg(jsonb_build_object('run_id',i.run_id,'operation',i.operation,
   'locked_pairs',CASE WHEN jsonb_typeof(i.manifest#>'{scope_measurement,executable_query_pairs}')='array'
     THEN i.manifest#>'{scope_measurement,executable_query_pairs}' ELSE bb_integrity_query_scope_pairs(i.manifest->'draft') END,
   'verified_pair_count',bb_integrity_verified_query_pair_count(i.owner_user_id,i.run_id,i.result->'records'),
   'verified_pairs',(SELECT COALESCE(jsonb_agg(pair ORDER BY pair),'[]') FROM (
     SELECT DISTINCT jsonb_build_object('subject_id',rec->>'subject_id','site_id',rec->>'site_id') pair
     FROM jsonb_array_elements(COALESCE(i.result->'records','[]')) rec
     WHERE bb_integrity_query_evidence_ready(i.owner_user_id,i.run_id,jsonb_build_array(rec))) verified)
   ) ORDER BY i.run_id) FROM bb_integrity_runs i JOIN scope_runs s ON s.run_id=i.run_id WHERE i.owner_user_id=$1),'[]')
) AS evidence`;
