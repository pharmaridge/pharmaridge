-- =====================================================================
-- MIGRATION 0004 — OWNER DATA MANAGEMENT AUDIT LOG
-- =====================================================================
--
-- The Owner may deliberately remove operational records to start a new
-- trading period or to retire an old deployment. This table deliberately
-- survives those actions. It records WHAT was requested, WHEN, the selected
-- range and the counts observed before deletion without retaining any of the
-- deleted patient/customer, supplier, staff or financial record contents.
--
-- `initiated_by` has NO foreign key on purpose: FULL_SETUP_RESET removes
-- manager/staff accounts, and an audit row must remain readable even when an
-- account mentioned in a historical log no longer exists. An Owner account is
-- always preserved by the route, but this table should not rely on that policy
-- for its own integrity.
CREATE TABLE data_cleanup_log (
    id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    mode                   TEXT NOT NULL CHECK (mode IN ('PERIOD','ALL_BUSINESS_DATA','FULL_SETUP_RESET')),
    initiated_by           TEXT NOT NULL,
    initiated_by_username  TEXT NOT NULL,
    start_date             TEXT,
    end_date               TEXT,
    deleted_summary_json   TEXT NOT NULL,
    created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_data_cleanup_log_created ON data_cleanup_log(created_at);

-- The server records the last Owner cleanup so a PWA queue created BEFORE
-- that cleanup can never silently repopulate records the Owner just removed when a
-- long-offline phone reconnects. The client sends the original queued time on
-- every replay; replays without that timestamp are deliberately refused after
-- a reset rather than guessed at.
ALTER TABLE client_settings ADD COLUMN data_reset_at TEXT;
