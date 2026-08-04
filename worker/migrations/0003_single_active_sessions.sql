-- =====================================================================
-- MIGRATION 0003 — ONE ACTIVE SESSION PER USER
-- =====================================================================
--
-- A shared pharmacy account must not be usable from two devices at once.
-- Concurrent cashiers under one username destroy attribution: a sale, till,
-- attendance record or void can no longer be tied to a physical person/device.
--
-- One row per user is the revocation authority. A successful login replaces
-- session_id atomically; every JWT carries that id and authRequired() compares
-- it with this row on every request. The device that signed in previously is
-- refused at its next request with SESSION_REPLACED and returned to login.
--
-- Deliberately not a historical session log. This table represents CURRENT
-- authority only; audit tables already record the actual business actions.
CREATE TABLE user_sessions (
    user_id     TEXT PRIMARY KEY REFERENCES users(id),
    session_id  TEXT NOT NULL,
    issued_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_user_sessions_session ON user_sessions(session_id);
