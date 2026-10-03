ALTER TABLE tenant_rate_window
  ADD COLUMN IF NOT EXISTS byte_count bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE tenant_rate_window
  DROP CONSTRAINT IF EXISTS tenant_rate_window_byte_count_check;
--> statement-breakpoint
ALTER TABLE tenant_rate_window
  ADD CONSTRAINT tenant_rate_window_byte_count_check CHECK (byte_count >= 0);
