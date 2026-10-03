import type { DatabaseMigration } from "./migration"

import migration0 from "./migration/20260127222353_familiar_lady_ursula"
import migration1 from "./migration/20260211171708_add_project_commands"
import migration2 from "./migration/20260213144116_wakeful_the_professor"
import migration3 from "./migration/20260225215848_workspace"
import migration4 from "./migration/20260227213759_add_session_workspace_id"
import migration5 from "./migration/20260228203230_blue_harpoon"
import migration6 from "./migration/20260303231226_add_workspace_fields"
import migration7 from "./migration/20260309230000_move_org_to_state"
import migration8 from "./migration/20260312043431_session_message_cursor"
import migration9 from "./migration/20260323234822_events"
import migration10 from "./migration/20260410174513_workspace-name"
import migration11 from "./migration/20260413175956_chief_energizer"
import migration12 from "./migration/20260423070820_add_icon_url_override"
import migration13 from "./migration/20260427172553_slow_nightmare"
import migration14 from "./migration/20260428004200_add_session_path"
import migration15 from "./migration/20260501142318_next_venus"
import migration16 from "./migration/20260504145000_add_sync_owner"
import migration17 from "./migration/20260507164347_add_workspace_time"
import migration18 from "./migration/20260510033149_session_usage"
import migration19 from "./migration/20260511000411_data_migration_state"
import migration20 from "./migration/20260511173437_session-metadata"
import migration21 from "./migration/20260601010001_normalize_storage_paths"
import migration22 from "./migration/20260601202201_amazing_prowler"
import migration23 from "./migration/20260602002951_lowly_union_jack"
import migration24 from "./migration/20260602182828_add_project_directories"
import migration25 from "./migration/20260603001617_session_message_projection_indexes"
import migration26 from "./migration/20260603040000_session_message_projection_order"
import migration27 from "./migration/20260603141458_session_input_inbox"
import migration28 from "./migration/20260603160727_jittery_ezekiel_stane"
import migration29 from "./migration/20260604172448_event_sourced_session_input"
import migration30 from "./migration/20260605003541_add_session_context_snapshot"
import migration31 from "./migration/20260605042240_add_context_epoch_agent"
import migration32 from "./migration/20260611035744_credential"
import migration33 from "./migration/20260611192811_lush_chimera"
import migration34 from "./migration/20260612174303_project_dir_strategy"
import migration35 from "./migration/20260622142730_simplify_session_context_epoch"
import migration36 from "./migration/20260622170816_reset_v2_session_state"
import migration37 from "./migration/20260622202450_simplify_session_input"
import migration38 from "./migration/20260726011601_arforge_goals"
import migration39 from "./migration/20260726064348_session_organization"
import migration40 from "./migration/20260726070221_scheduled_prompts"
import migration41 from "./migration/20260726072751_task_graph"
import migration42 from "./migration/20260726074902_team_mailbox"
import migration43 from "./migration/20260726101405_memory_learning"
import migration44 from "./migration/20260726103917_local_feedback"
import migration45 from "./migration/20260726104149_feedback_learning_link"
import migration46 from "./migration/20260726215226_feedback_workspace_scope"
import migration47 from "./migration/20260802044607_identity_and_tenant_ownership"
import migration48 from "./migration/20260803055810_memory_corrections"
import migration49 from "./migration/20260803064956_memory_conflicts"
import migration50 from "./migration/20260804090000_runtime_insight"
import migration51 from "./migration/20260810101500_control_run_claim_index"
import migration52 from "./migration/20260811184807_runtime_billing"
import migration53 from "./migration/20260811203452_evaluation_results"
import migration54 from "./migration/20260812045709_memory_kernel_persistence"
import migration55 from "./migration/20260812092948_session_share_operation_receipts"
import migration56 from "./migration/20260812105516_self_hosted_share_provider"
import migration57 from "./migration/20260812134845_learning_verified_outcomes"
import migration58 from "./migration/20260812140331_experience_graph"
import migration59 from "./migration/20260812143720_evolution_durable_runtime"
import migration60 from "./migration/20260813025236_stage7_durable_experience_skill"
import migration61 from "./migration/20260813125806_mailbox_protocol"
import migration62 from "./migration/20260813170016_tenant_platform_v1"
import migration63 from "./migration/20260813170442_tenant_platform_v1_constraints"
import migration64 from "./migration/20260815100730_memory_candidate_review_audit"
import migration65 from "./migration/20260815103339_memory_candidate_workspace_scope"
import migration66 from "./migration/20260822230244_workflow_node_read_default"
import migration67 from "./migration/20260823015029_credential_tenant_envelope"
import migration68 from "./migration/20260826034444_artifact_maintenance_scan"
import migration69 from "./migration/20260826035017_artifact_maintenance_scan_start_cursor"
import migration70 from "./migration/20260826054241_artifact_maintenance_lease"
import migration71 from "./migration/20260826121545_session_compaction_checkpoint"
import migration72 from "./migration/20260826144704_tenant_artifact_read_bytes"
import migration73 from "./migration/20260902192412_child_settlement_recovery_outbox"
import migration74 from "./migration/20260902192806_child_settlement_recovery_outbox_receipt_digest"
import migration75 from "./migration/20260903205327_20260904120000_child_settlement_recovery_outbox_owner_progress"
import migration76 from "./migration/20260908114322_runtime_billing_receipt"

export const migrations = [
  migration0,
  migration1,
  migration2,
  migration3,
  migration4,
  migration5,
  migration6,
  migration7,
  migration8,
  migration9,
  migration10,
  migration11,
  migration12,
  migration13,
  migration14,
  migration15,
  migration16,
  migration17,
  migration18,
  migration19,
  migration20,
  migration21,
  migration22,
  migration23,
  migration24,
  migration25,
  migration26,
  migration27,
  migration28,
  migration29,
  migration30,
  migration31,
  migration32,
  migration33,
  migration34,
  migration35,
  migration36,
  migration37,
  migration38,
  migration39,
  migration40,
  migration41,
  migration42,
  migration43,
  migration44,
  migration45,
  migration46,
  migration47,
  migration48,
  migration49,
  migration50,
  migration51,
  migration52,
  migration53,
  migration54,
  migration55,
  migration56,
  migration57,
  migration58,
  migration59,
  migration60,
  migration61,
  migration62,
  migration63,
  migration64,
  migration65,
  migration66,
  migration67,
  migration68,
  migration69,
  migration70,
  migration71,
  migration72,
  migration73,
  migration74,
  migration75,
  migration76,
] satisfies DatabaseMigration.Migration[]
