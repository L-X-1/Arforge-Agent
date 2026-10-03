--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON feedback;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON feedback
  USING (
    tenant_id = arforge_current_tenant_id()
    AND arforge_has_tenant_access(tenant_id)
    AND (session_id IS NULL OR arforge_has_session_access(session_id))
  )
  WITH CHECK (
    tenant_id = arforge_current_tenant_id()
    AND owner_user_id = arforge_current_user_id()
    AND arforge_has_tenant_access(tenant_id)
    AND (session_id IS NULL OR arforge_has_session_access(session_id))
  );
