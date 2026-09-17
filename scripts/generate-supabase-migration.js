"use strict";

/**
 * Membuat SQL migrasi PRIVAT dari database SQLite lama ke Supabase/PostgreSQL.
 * Script ini TIDAK mengirim data ke internet.
 * Output default: migration/private_supabase_data.sql (sudah di-gitignore).
 *
 * Jalankan dari project lama yang masih memiliki database/pilketos.db:
 *   npm run migrate:sqlite
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = process.env.SQLITE_PATH || path.join(ROOT, "database", "pilketos.db");
const OUTPUT = process.env.MIGRATION_OUTPUT || path.join(ROOT, "migration", "private_supabase_data.sql");

if (!fs.existsSync(DB_PATH)) {
    console.error(`Database SQLite tidak ditemukan: ${DB_PATH}`);
    console.error("Salin database/pilketos.db dari project lama, lalu jalankan ulang.");
    process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

function rows(table) {
    try {
        return db.prepare(`SELECT * FROM "${table}"`).all();
    } catch {
        return [];
    }
}

function q(value) {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
    if (typeof value === "bigint") return String(value);
    return `'${String(value).replaceAll("'", "''")}'`;
}

function cleanLegacyImage(value) {
    if (!value) return null;
    const s = String(value);
    // /uploads/... adalah file lokal lama yang tidak ikut ke Vercel.
    return s.startsWith("/uploads/") ? null : s;
}

function insertStatement(table, columns, data, conflictColumn = "id") {
    if (!data.length) return `-- ${table}: tidak ada data\n`;
    const values = data.map(row =>
        `(${columns.map(c => q(row[c])).join(", ")})`
    ).join(",\n");
    const updates = columns
        .filter(c => c !== conflictColumn)
        .map(c => `${c} = EXCLUDED.${c}`)
        .join(", ");
    return `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values}\nON CONFLICT (${conflictColumn}) DO UPDATE SET ${updates};\n`;
}

const settings = rows("election_settings").map(r => ({
    id: r.id,
    status: r.status,
    published: r.published ?? 0,
    hero_image: cleanLegacyImage(r.hero_image),
    updated_at: r.updated_at
}));

const candidates = rows("candidates").map(r => ({
    id: r.id,
    number: r.number,
    name: r.name,
    chairman: r.chairman,
    vice: r.vice,
    photo: cleanLegacyImage(r.photo),
    created_at: r.created_at
}));

const roles = rows("voter_roles");
const classes = rows("voter_classes");
const departments = rows("voter_departments");
const codes = rows("voter_codes");
const votes = rows("votes");
const archive = rows("votes_archive");
const logs = rows("admin_log");

const blocks = [
    "-- PILKETOS private data migration\n-- GENERATED FILE: jangan commit / jangan upload ke repository publik.\nBEGIN;\n",
    insertStatement("election_settings", ["id", "status", "published", "hero_image", "updated_at"], settings),
    insertStatement("voter_roles", ["id", "name", "active"], roles),
    insertStatement("voter_classes", ["id", "name", "active"], classes),
    insertStatement("voter_departments", ["id", "class_id", "name", "active"], departments),
    insertStatement("candidates", ["id", "number", "name", "chairman", "vice", "photo", "created_at"], candidates),
    insertStatement("voter_codes", ["id", "code", "role_id", "class_id", "department_id", "used", "created_at", "used_at"], codes),
    insertStatement("votes", ["id", "candidate_id", "voter_code_id", "role_id", "class_id", "department_id", "created_at"], votes),
    insertStatement("votes_archive", ["id", "candidate_id", "voter_code_id", "role_id", "class_id", "department_id", "original_created_at", "archived_at", "batch_id", "deleted_reason"], archive),
    insertStatement("admin_log", ["id", "action", "detail", "election_status", "rows_affected", "ip", "created_at"], logs),
    `\n-- Sinkronkan SERIAL sequence setelah insert ID eksplisit.\n` +
    ["candidates", "voter_roles", "voter_classes", "voter_departments", "voter_codes", "votes", "admin_log"]
        .map(t => `SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 1), 1), true);`)
        .join("\n") + "\n",
    "COMMIT;\n"
];

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, blocks.join("\n"), { mode: 0o600 });

db.close();

console.log(`SQL migrasi dibuat: ${OUTPUT}`);
console.log("PERINGATAN: file ini berisi kode pemilih/suara/data audit. Jangan commit atau upload ke GitHub.");
console.log("Foto lokal /uploads lama sengaja di-set NULL. Upload ulang foto melalui Admin setelah deploy.");
