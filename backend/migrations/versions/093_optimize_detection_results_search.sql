-- Migration 093: Optimize detection_results search performance
--
-- Problem:
--   On tenants with hundreds of thousands of rows, listing detection results
--   with content keyword search produces 504 timeouts. The default sort
--   (created_at DESC) plus a tenant filter forces a sort over all matching
--   rows, and `content LIKE '%keyword%'` is a full table scan over a Text
--   column without any index.
--
-- Fixes:
--   1. Composite index on (tenant_id, created_at DESC) — covers the default
--      tenant-scoped paginated list. PostgreSQL can walk the index backwards
--      and apply LIMIT without sorting.
--   2. pg_trgm GIN index on content — supports substring search via ILIKE
--      (and LIKE) with sub-second latency on multi-million-row tables.
--   3. pg_trgm GIN index on request_id — same, for the request_id_search
--      filter (currently unindexed substring match).
--
-- Notes:
--   - All statements are idempotent (IF NOT EXISTS).
--   - This migration runs inside a transaction (see run_migrations.py), so
--     CREATE INDEX runs with a short ACCESS EXCLUSIVE lock on writes during
--     creation. On a multi-million-row table this can take minutes; for
--     such cases an operator can pre-create the same indexes manually with
--     CREATE INDEX CONCURRENTLY before deploying — the IF NOT EXISTS
--     clauses below will then no-op.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_detection_results_tenant_created
    ON detection_results (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_detection_results_content_trgm
    ON detection_results USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_detection_results_request_id_trgm
    ON detection_results USING gin (request_id gin_trgm_ops);
