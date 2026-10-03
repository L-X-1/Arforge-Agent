ALTER TABLE "child_settlement_recovery_outbox"
  ADD COLUMN IF NOT EXISTS "owner_progress" text;
