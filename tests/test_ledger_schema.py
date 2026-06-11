from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schema" / "postgres_schema.sql"


def _normalized_schema() -> str:
    return " ".join(SCHEMA_PATH.read_text(encoding="utf-8").lower().split())


def test_ledger_tables_are_idempotent():
    schema = _normalized_schema()

    for table in [
        "ledger_agents",
        "ledger_lanes",
        "ledger_sessions",
        "ledger_leases",
        "ledger_events",
        "ledger_probe_files",
        "ledger_artifacts",
    ]:
        assert f"create table if not exists {table}" in schema


def test_ledger_events_stores_source_jsonl_location_and_redacted_event_fields():
    schema = _normalized_schema()

    for column in [
        "event_id text primary key",
        "actor_json jsonb",
        "payload_json jsonb",
        "redaction_json jsonb",
        "jsonl_path text",
        "jsonl_line_number integer",
        "jsonl_byte_offset bigint",
        "prev_hash text",
        "hash text",
    ]:
        assert column in schema


def test_ledger_indexes_cover_common_queries():
    schema = _normalized_schema()

    for index_sql in [
        "create index if not exists idx_ledger_events_component_created on ledger_events(component, created_at)",
        "create index if not exists idx_ledger_events_agent_id on ledger_events(agent_id)",
        "create index if not exists idx_ledger_events_lane_id on ledger_events(lane_id)",
        "create index if not exists idx_ledger_events_session_id on ledger_events(session_id)",
        "create index if not exists idx_ledger_events_command_id on ledger_events(command_id)",
        "create index if not exists idx_ledger_events_event_type on ledger_events(event_type)",
        "create index if not exists idx_ledger_leases_status_expires on ledger_leases(status, expires_at)",
        "create index if not exists idx_ledger_probe_files_session_trusted on ledger_probe_files(session_id, trusted)",
    ]:
        assert index_sql in schema


def test_ledger_schema_keeps_one_active_mutation_lease_per_session():
    schema = _normalized_schema()

    for index_sql in [
        "create unique index if not exists idx_ledger_leases_one_active_lane on ledger_leases(lease_type, lane_id) where status = 'active' and lease_type = 'lane'",
        "create unique index if not exists idx_ledger_leases_one_active_session_mutation on ledger_leases(lease_type, lane_id, session_id) where status = 'active' and lease_type = 'session_mutation'",
    ]:
        assert index_sql in schema
