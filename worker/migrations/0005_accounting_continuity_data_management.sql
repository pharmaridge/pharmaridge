-- =====================================================================
-- MIGRATION 0005 — ACCOUNTING-CONTINUITY DATA-MANAGEMENT MODE
-- =====================================================================
-- Adds an Owner-only reset mode that deletes the live operating dataset while
-- preserving the numeric accounting history (posted GL and branch-safe cash
-- history) needed for continuity of Trial Balance, P&L and Balance Sheet.
--
-- SQLite cannot alter a CHECK constraint in place. data_cleanup_log has no
-- foreign-key relationship, so recreate it atomically with the new allowed
-- mode and preserve every prior minimal cleanup row.
CREATE TABLE data_cleanup_log_next (
    id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    mode                   TEXT NOT NULL CHECK (mode IN ('PERIOD','ALL_BUSINESS_DATA','CLEAR_OPERATIONAL_KEEP_ACCOUNTING','FULL_SETUP_RESET')),
    initiated_by           TEXT NOT NULL,
    initiated_by_username  TEXT NOT NULL,
    start_date             TEXT,
    end_date               TEXT,
    deleted_summary_json   TEXT NOT NULL,
    created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO data_cleanup_log_next (
    id, mode, initiated_by, initiated_by_username, start_date, end_date,
    deleted_summary_json, created_at
)
SELECT id, mode, initiated_by, initiated_by_username, start_date, end_date,
       deleted_summary_json, created_at
FROM data_cleanup_log;

DROP TABLE data_cleanup_log;
ALTER TABLE data_cleanup_log_next RENAME TO data_cleanup_log;
CREATE INDEX idx_data_cleanup_log_created ON data_cleanup_log(created_at);
