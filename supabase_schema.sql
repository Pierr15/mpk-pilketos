-- ============================================================
--  PILKETOS 2026 — Supabase / PostgreSQL Schema
--  Jalankan seluruh file ini di Supabase SQL Editor
--  (Dashboard → SQL Editor → New query → paste → Run)
-- ============================================================

-- ── Ekstensi ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- ── Tabel utama ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS election_settings (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    status          TEXT    NOT NULL DEFAULT 'DRAFT',
    published       INTEGER NOT NULL DEFAULT 0,
    hero_image      TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT election_settings_single_row CHECK (id = 1)
);
INSERT INTO election_settings (id, status) VALUES (1, 'DRAFT')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS candidates (
    id          SERIAL PRIMARY KEY,
    number      INTEGER NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    chairman    TEXT    NOT NULL,
    vice        TEXT    NOT NULL,
    photo       TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voter_roles (
    id     SERIAL PRIMARY KEY,
    name   TEXT    NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO voter_roles (name, active) VALUES
    ('SISWA', 1), ('GURU', 1), ('STAFF', 1)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS voter_classes (
    id     SERIAL PRIMARY KEY,
    name   TEXT    NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO voter_classes (name, active) VALUES
    ('Kelas 10', 1), ('Kelas 11', 1), ('Kelas 12', 1)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS voter_departments (
    id       SERIAL PRIMARY KEY,
    class_id INTEGER NOT NULL REFERENCES voter_classes(id) ON DELETE CASCADE,
    name     TEXT    NOT NULL,
    active   INTEGER NOT NULL DEFAULT 1,
    UNIQUE (class_id, name)
);

CREATE TABLE IF NOT EXISTS voter_codes (
    id            SERIAL PRIMARY KEY,
    code          TEXT    NOT NULL UNIQUE,
    role_id       INTEGER REFERENCES voter_roles(id),
    class_id      INTEGER REFERENCES voter_classes(id),
    department_id INTEGER REFERENCES voter_departments(id),
    used          INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    used_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS votes (
    id             SERIAL PRIMARY KEY,
    candidate_id   INTEGER NOT NULL REFERENCES candidates(id),
    voter_code_id  INTEGER NOT NULL UNIQUE REFERENCES voter_codes(id),
    role_id        INTEGER REFERENCES voter_roles(id),
    class_id       INTEGER REFERENCES voter_classes(id),
    department_id  INTEGER REFERENCES voter_departments(id),
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS votes_archive (
    id                  INTEGER PRIMARY KEY,
    candidate_id        INTEGER NOT NULL,
    voter_code_id       INTEGER NOT NULL,
    role_id             INTEGER,
    class_id            INTEGER,
    department_id       INTEGER,
    original_created_at TIMESTAMPTZ,
    archived_at         TIMESTAMPTZ DEFAULT NOW(),
    batch_id            TEXT NOT NULL,
    deleted_reason      TEXT
);

CREATE TABLE IF NOT EXISTS admin_log (
    id               SERIAL PRIMARY KEY,
    action           TEXT NOT NULL,
    detail           TEXT,
    election_status  TEXT,
    rows_affected    INTEGER DEFAULT 0,
    ip               TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Row Level Security ──────────────────────────────────────
-- Backend memakai Supabase Secret key, yang bekerja sebagai role service_role
-- dan melewati RLS. RLS tetap diaktifkan agar browser/public key tidak dapat
-- mengakses tabel aplikasi secara langsung.
ALTER TABLE election_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE voter_roles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE voter_classes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE voter_departments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE voter_codes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes_archive      ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_log          ENABLE ROW LEVEL SECURITY;

-- ── Index untuk performa ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_voter_codes_code    ON voter_codes(code);
CREATE INDEX IF NOT EXISTS idx_voter_codes_used    ON voter_codes(used);
CREATE INDEX IF NOT EXISTS idx_votes_candidate     ON votes(candidate_id);
CREATE INDEX IF NOT EXISTS idx_votes_role          ON votes(role_id);
CREATE INDEX IF NOT EXISTS idx_votes_class         ON votes(class_id);
CREATE INDEX IF NOT EXISTS idx_admin_log_created   ON admin_log(created_at DESC);

-- ── Fungsi atomik: cast vote (mencegah race condition) ────
-- Dipanggil dari server lewat supabase.rpc('cast_vote', {...})
CREATE OR REPLACE FUNCTION cast_vote(
    p_code_id     INTEGER,
    p_candidate_id INTEGER,
    p_role_id     INTEGER,
    p_class_id    INTEGER,
    p_dept_id     INTEGER
) RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_used INTEGER;
BEGIN
    -- Lock baris kode pemilih
    SELECT used INTO v_used FROM voter_codes WHERE id = p_code_id FOR UPDATE;

    IF v_used IS NULL THEN
        RETURN 'CODE_NOT_FOUND';
    END IF;

    IF v_used = 1 THEN
        RETURN 'ALREADY_USED';
    END IF;

    -- Tandai kode sebagai terpakai
    UPDATE voter_codes
    SET used = 1, used_at = NOW()
    WHERE id = p_code_id;

    -- Catat suara
    INSERT INTO votes (candidate_id, voter_code_id, role_id, class_id, department_id)
    VALUES (p_candidate_id, p_code_id, p_role_id, p_class_id, p_dept_id);

    RETURN 'OK';
END;
$$;

-- ── Fungsi atomik: arsipkan lalu kosongkan suara ────────────
CREATE OR REPLACE FUNCTION archive_and_clear_votes(
    p_batch_id TEXT,
    p_reason   TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    INSERT INTO votes_archive (
        id, candidate_id, voter_code_id, role_id, class_id, department_id,
        original_created_at, batch_id, deleted_reason
    )
    SELECT
        id, candidate_id, voter_code_id, role_id, class_id, department_id,
        created_at, p_batch_id, p_reason
    FROM votes;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    DELETE FROM votes;
    RETURN v_count;
END;
$$;

-- ── Fungsi atomik: pulihkan batch arsip terakhir ────────────
CREATE OR REPLACE FUNCTION restore_last_vote_batch()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_batch_id TEXT;
    v_count    INTEGER := 0;
BEGIN
    SELECT batch_id
    INTO v_batch_id
    FROM votes_archive
    ORDER BY archived_at DESC
    LIMIT 1;

    IF v_batch_id IS NULL THEN
        RETURN 0;
    END IF;

    IF EXISTS (SELECT 1 FROM votes) THEN
        RAISE EXCEPTION 'Restore hanya dapat dilakukan saat tabel votes kosong.';
    END IF;

    INSERT INTO votes (
        id, candidate_id, voter_code_id, role_id, class_id, department_id, created_at
    )
    SELECT
        id, candidate_id, voter_code_id, role_id, class_id, department_id, original_created_at
    FROM votes_archive
    WHERE batch_id = v_batch_id;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE voter_codes
    SET used = 1,
        used_at = NOW()
    WHERE id IN (
        SELECT voter_code_id
        FROM votes_archive
        WHERE batch_id = v_batch_id
    );

    DELETE FROM votes_archive WHERE batch_id = v_batch_id;
    RETURN v_count;
END;
$$;

-- ── Supabase Storage untuk hero image & foto paslon ─────────
-- Bucket dibuat public agar browser bisa menampilkan gambar lewat CDN.
INSERT INTO storage.buckets (
    id, name, public, file_size_limit, allowed_mime_types
)
VALUES (
    'pilketos-assets',
    'pilketos-assets',
    TRUE,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Backend memakai secret key (role service_role). Tidak ada akses DB langsung
-- dari browser; RLS tetap aktif untuk semua tabel aplikasi.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

REVOKE ALL ON FUNCTION cast_vote(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION archive_and_clear_votes(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION restore_last_vote_batch() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION cast_vote(INTEGER, INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION archive_and_clear_votes(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION restore_last_vote_batch() TO service_role;
