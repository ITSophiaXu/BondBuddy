-- Deployment ACL for the four pre-provisioned execution consumer identities.
-- No schema migration, ownership change, destructive privileges or PUBLIC grant.
GRANT SELECT, INSERT, UPDATE ON TABLE
 public.bb_performance_sessions, public.bb_performance_spans
 TO bb1361_formal_n1_author_v1, bb1361_formal_n1_review_v1,
    bb1361_formal_n2_author_v1, bb1361_formal_n2_review_v1;
