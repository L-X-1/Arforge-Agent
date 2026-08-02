-- Non-destructive Arforge-Agent -> unified Arforge schema migration.
-- Legacy tables remain intact; deterministic IDs make this script idempotent.

INSERT INTO memory (
  id,
  content,
  type,
  tags,
  importance,
  source,
  scope,
  project_id,
  workspace_path,
  related_to,
  strength,
  review_level,
  time_reviewed,
  time_created,
  time_updated
)
SELECT
  'mem_legacy_' || id::text,
  content,
  mem_type,
  CASE
    WHEN trim(tags) = '' THEN '[]'
    ELSE to_json(string_to_array(tags, ','))::text
  END,
  greatest(0, least(5, importance)),
  CASE
    WHEN source IN ('user', 'user-corrected', 'imported', 'auto', 'model', 'quarantined', 'quarantined:auto', 'quarantined:model')
      THEN source
    ELSE 'imported'
  END,
  CASE WHEN trim(workspace_path) = '' THEN 'global' ELSE 'workspace' END,
  nullif(project_id, ''),
  nullif(workspace_path, ''),
  NULL,
  greatest(0, least(1, strength)),
  greatest(0, least(5, review_level)),
  CASE
    WHEN trim(last_reviewed_at) = '' THEN NULL
    ELSE (extract(epoch FROM last_reviewed_at::timestamp) * 1000)::bigint
  END,
  (extract(epoch FROM created_at::timestamp) * 1000)::bigint,
  (extract(epoch FROM updated_at::timestamp) * 1000)::bigint
FROM memories
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning_outcome (
  id,
  session_id,
  project_id,
  workspace_path,
  turn_index,
  user_input,
  intent,
  route,
  tools,
  success,
  error_type,
  error_message,
  user_feedback,
  fix_strategy,
  regression,
  token_count,
  response_time_ms,
  tags,
  importance,
  injected_context_size,
  fingerprint,
  time_created
)
SELECT
  'lout_legacy_' || id::text,
  NULL,
  'legacy:arforge-agent',
  'E:\Arforge-Agent',
  greatest(0, turn_index),
  user_input,
  intent,
  route,
  tools_used,
  success <> 0,
  error_type,
  error_message,
  user_feedback,
  fix_strategy,
  regression <> 0,
  greatest(0, tokens_used),
  greatest(0, round(response_time_ms)::bigint),
  tags,
  greatest(0, least(5, round(importance)::bigint)),
  greatest(0, injected_context_size),
  NULL,
  (extract(epoch FROM created_at::timestamp) * 1000)::bigint
FROM learning_outcomes
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning_outcome (
  id,
  session_id,
  project_id,
  workspace_path,
  turn_index,
  user_input,
  intent,
  route,
  tools,
  success,
  error_type,
  error_message,
  user_feedback,
  fix_strategy,
  regression,
  token_count,
  response_time_ms,
  tags,
  importance,
  injected_context_size,
  fingerprint,
  time_created
)
SELECT
  'lout_legacy_experience_' || id::text,
  NULL,
  'legacy:arforge-agent',
  'E:\Arforge-Agent',
  greatest(0, coalesce((payload::jsonb ->> 'turn_index')::bigint, 0)),
  coalesce(payload::jsonb ->> 'user_input', ''),
  coalesce(payload::jsonb ->> 'route_type', route_type, 'general'),
  coalesce(payload::jsonb ->> 'route_type', route_type, 'agentic'),
  coalesce((payload::jsonb -> 'tools_used')::text, '[]'),
  has_error = 0,
  coalesce(payload::jsonb ->> 'error_type', ''),
  coalesce(payload::jsonb ->> 'error_message', ''),
  coalesce(payload::jsonb ->> 'user_feedback', ''),
  coalesce(payload::jsonb ->> 'fix_strategy', ''),
  false,
  greatest(0, coalesce((payload::jsonb ->> 'token_count')::bigint, 0)),
  greatest(0, round(coalesce((payload::jsonb ->> 'response_time_ms')::double precision, 0))::bigint),
  CASE
    WHEN trim(coalesce(payload::jsonb ->> 'tags', '')) = '' THEN '["legacy-experience"]'
    ELSE to_json(string_to_array(payload::jsonb ->> 'tags', ','))::text
  END,
  greatest(0, least(5, round(importance)::bigint)),
  0,
  NULL,
  (extract(epoch FROM created_at::timestamp) * 1000)::bigint
FROM learning_experiences
ON CONFLICT (id) DO NOTHING;

INSERT INTO learning_pattern (
  id,
  project_id,
  workspace_path,
  type,
  description,
  frequency,
  confidence,
  tags,
  time_created,
  time_updated
)
SELECT
  'lpat_legacy_' || id::text,
  'legacy:arforge-agent',
  'E:\Arforge-Agent',
  pattern_type,
  description,
  greatest(1, frequency),
  greatest(0, least(1, confidence)),
  tags,
  (extract(epoch FROM created_at::timestamp) * 1000)::bigint,
  (extract(epoch FROM updated_at::timestamp) * 1000)::bigint
FROM learning_patterns
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS arforge_legacy_migration (
  id text PRIMARY KEY,
  time_completed bigint NOT NULL
);

INSERT INTO arforge_legacy_migration (id, time_completed)
VALUES ('arforge-agent-postgres-v1', (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
ON CONFLICT (id) DO UPDATE SET time_completed = EXCLUDED.time_completed;
