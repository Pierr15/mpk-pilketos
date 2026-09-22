"use strict";

require("dotenv").config();

const express = require("express");
const path    = require("path");
const multer  = require("multer");
const crypto  = require("crypto");
const db      = require("./db");
const media   = require("./storage");

// ─────────────────────────────────────────────
//  KONFIGURASI
// ─────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const MAX_GENERATE_CODES = 10000;

/* Password admin — wajib ada */
const ADMIN_PASSWORD_RAW = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD_RAW) {
    throw new Error("ADMIN_PASSWORD belum diatur di environment variable.");
}
const ADMIN_PASSWORD_HASH = crypto
    .createHash("sha256")
    .update(ADMIN_PASSWORD_RAW)
    .digest();

const ADMIN_SESSION_COOKIE = "pilketos_admin_session";
const ADMIN_SESSION_TTL = 8 * 60 * 60 * 1000; // 8 jam
const ADMIN_SESSION_SECRET_RAW =
    process.env.ADMIN_SESSION_SECRET ||
    process.env.VOTE_TOKEN_SECRET ||
    ADMIN_PASSWORD_RAW;

const ROOT_DIR   = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PRIVATE_DIR = path.join(ROOT_DIR, "private");

// ─────────────────────────────────────────────
//  UPLOAD FILE (foto paslon & hero)
//  Vercel filesystem bersifat ephemeral, jadi file disimpan di Supabase Storage.
// ─────────────────────────────────────────────
const ALLOWED_IMG_SIGS = [
    { bytes: [0xFF, 0xD8, 0xFF], ext: ".jpg" },
    { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], ext: ".png" },
    { bytes: [0x52, 0x49, 0x46, 0x46], ext: ".webp", extra: [0x57, 0x45, 0x42, 0x50], extraOffset: 8 }
];

function detectImageType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    for (const sig of ALLOWED_IMG_SIGS) {
        if (!sig.bytes.every((b, i) => buffer[i] === b)) continue;
        if (sig.extra && !sig.extra.every((b, i) => buffer[sig.extraOffset + i] === b)) continue;
        return sig.ext;
    }
    return null;
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ["image/jpeg", "image/png", "image/webp"];
        if (!allowed.includes((file.mimetype || "").toLowerCase()))
            return cb(Object.assign(new Error("Format foto harus JPG, PNG, atau WEBP."), { isValidation: true }));
        cb(null, true);
    }
});

// ─────────────────────────────────────────────
//  AUTENTIKASI & RATE LIMIT
// ─────────────────────────────────────────────
const loginFails  = new Map();
const verifyFails = new Map();

function getIp(req) {
    return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
        .split(",")[0].trim().substring(0, 45);
}

function makeRateLimiter(maxFail, windowMs, lockoutMs) {
    return {
        check(ip) {
            const now = Date.now();
            const rec = loginFails.get(ip);
            if (!rec) return true;
            if (now > rec.resetAt) { loginFails.delete(ip); return true; }
            return rec.count < maxFail;
        },
        fail(ip, map = loginFails) {
            const now = Date.now();
            const rec = map.get(ip) || { count: 0, resetAt: now + lockoutMs };
            rec.count++;
            if (rec.count >= maxFail) rec.resetAt = now + lockoutMs;
            map.set(ip, rec);
        },
        clear(ip, map = loginFails) { map.delete(ip); }
    };
}

const loginRL  = makeRateLimiter(10, 60000, 300000);
const verifyRL = {
    check(ip) {
        const now = Date.now();
        const rec = verifyFails.get(ip);
        if (!rec) return true;
        if (now > rec.resetAt) { verifyFails.delete(ip); return true; }
        return rec.count < 10;
    },
    fail(ip) {
        const now = Date.now();
        const rec = verifyFails.get(ip) || { count: 0, resetAt: now + 60000 };
        rec.count++;
        if (rec.count >= 10) rec.resetAt = now + 60000;
        verifyFails.set(ip, rec);
    },
    clear(ip) { verifyFails.delete(ip); }
};

function checkAdminPassword(req) {
    const raw = req.headers["x-admin-password"] || req.body?.password;
    if (!raw) return false;
    try {
        return crypto.timingSafeEqual(
            crypto.createHash("sha256").update(String(raw)).digest(),
            ADMIN_PASSWORD_HASH
        );
    } catch { return false; }
}

function parseCookies(req) {
    const raw = String(req.headers.cookie || "");
    const out = {};
    for (const part of raw.split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) continue;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!key) continue;
        try { out[key] = decodeURIComponent(value); }
        catch { out[key] = value; }
    }
    return out;
}

function signAdminSessionPayload(encodedPayload) {
    return crypto
        .createHmac("sha256", ADMIN_SESSION_SECRET_RAW)
        .update(encodedPayload)
        .digest("base64url");
}

function createAdminSessionToken() {
    const payload = {
        v: 1,
        iat: Date.now(),
        exp: Date.now() + ADMIN_SESSION_TTL
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${signAdminSessionPayload(encoded)}`;
}

function verifyAdminSessionToken(token) {
    try {
        const [encoded, signature, extra] = String(token || "").split(".");
        if (!encoded || !signature || extra !== undefined) return null;

        const expected = Buffer.from(signAdminSessionPayload(encoded));
        const actual = Buffer.from(signature);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

        const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (payload.v !== 1 || !Number.isFinite(payload.exp) || Date.now() > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}

function getAdminSession(req) {
    const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
    return verifyAdminSessionToken(token);
}

function setAdminSessionCookie(res) {
    const token = createAdminSessionToken();
    const secure = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
    const maxAge = Math.floor(ADMIN_SESSION_TTL / 1000);
    res.setHeader(
        "Set-Cookie",
        `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
    );
}

function clearAdminSessionCookie(res) {
    const secure = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
    res.setHeader(
        "Set-Cookie",
        `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`
    );
}

async function requireAdmin(req, res, next) {
    if (getAdminSession(req)) return next();

    const ip = getIp(req);
    if (!loginRL.check(ip)) {
        return res.status(429).json({ success: false, message: "Terlalu banyak percobaan. Coba beberapa menit lagi." });
    }
    if (!checkAdminPassword(req)) {
        loginRL.fail(ip);
        return res.status(401).json({ success: false, message: "Sesi administrator tidak valid." });
    }
    loginRL.clear(ip);
    next();
}

async function requireDraft(req, res, next) {
    const status = await db.getElectionStatus();
    if (status !== "DRAFT") {
        return res.status(403).json({ success: false, message: "Pengaturan hanya dapat dilakukan saat status DRAFT." });
    }
    next();
}

// ─────────────────────────────────────────────
//  VOTE TOKEN (stateless HMAC, TTL 10 menit)
//  Aman untuk Vercel karena tidak bergantung pada RAM instance.
// ─────────────────────────────────────────────
const TOKEN_TTL = 10 * 60 * 1000;
const VOTE_TOKEN_SECRET_RAW = process.env.VOTE_TOKEN_SECRET || ADMIN_PASSWORD_RAW;

if (!process.env.VOTE_TOKEN_SECRET && process.env.VERCEL) {
    throw new Error("VOTE_TOKEN_SECRET wajib diatur pada deployment Vercel.");
}

function signVotePayload(encodedPayload) {
    return crypto
        .createHmac("sha256", VOTE_TOKEN_SECRET_RAW)
        .update(encodedPayload)
        .digest("base64url");
}

function createVoteToken(voterCodeId, roleId, classId, departmentId) {
    const payload = {
        v: 1,
        voterCodeId,
        roleId: roleId || null,
        classId: classId || null,
        departmentId: departmentId || null,
        exp: Date.now() + TOKEN_TTL
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${signVotePayload(encoded)}`;
}

function verifyVoteToken(token) {
    try {
        const [encoded, signature, extra] = String(token || "").split(".");
        if (!encoded || !signature || extra !== undefined) return null;

        const expected = Buffer.from(signVotePayload(encoded));
        const actual = Buffer.from(signature);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

        const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (payload.v !== 1 || !Number.isInteger(payload.voterCodeId)) return null;
        if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* Halaman admin tidak pernah dikirim sebelum session cookie valid. */
app.get(["/admin", "/admin.html"], (req, res) => {
    if (!getAdminSession(req)) return res.redirect(302, "/admin-login.html");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(PRIVATE_DIR, "admin.html"));
});

app.get(["/admin-login", "/admin-login.html"], (req, res) => {
    if (getAdminSession(req)) return res.redirect(302, "/admin.html");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(PUBLIC_DIR, "admin-login.html"));
});

app.use(express.static(PUBLIC_DIR, {
    setHeaders(res, fp) {
        if ([".js", ".css", ".html"].some(e => fp.endsWith(e))) res.setHeader("Cache-Control", "no-store");
    }
}));

// ─────────────────────────────────────────────
//  HELPER: utilitas kode pemilih
// ─────────────────────────────────────────────
function normalizeCode(code) {
    return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function generateCode(existingCodes) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (let i = 0; i < 10000; i++) {
        const bytes = crypto.randomBytes(5);
        let code = "";
        for (let j = 0; j < 5; j++) code += chars[bytes[j] % chars.length];
        if (!existingCodes.has(code)) { existingCodes.add(code); return code; }
    }
    throw new Error("Gagal membuat kode unik.");
}

// ─────────────────────────────────────────────
//  HELPER: audit log
// ─────────────────────────────────────────────
async function audit(action, detail, rows, req) {
    const status = await db.getElectionStatus().catch(() => "?");
    await db.writeAuditLog(action, detail, rows, req ? getIp(req) : null, status);
}

// ─────────────────────────────────────────────
//  ROUTES — HALAMAN STATIS
// ─────────────────────────────────────────────
app.get("/",             (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/vote.html",    (req, res) => res.sendFile(path.join(PUBLIC_DIR, "vote.html")));
app.get("/results.html", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "results.html")));

// ─────────────────────────────────────────────
//  API PUBLIK
// ─────────────────────────────────────────────
app.get("/api/election", async (req, res) => {
    try {
        const s = await db.getElectionSettings();
        res.json({ success: true, status: s.status, published: s.published === 1, heroImage: s.heroImage });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal mengambil status." }); }
});

app.get("/api/candidates", async (req, res) => {
    try {
        res.json({ success: true, candidates: await db.getCandidates() });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal mengambil data Paslon." }); }
});

app.get("/api/voter-config", async (req, res) => {
    try {
        const [roles, classes] = await Promise.all([db.getRoles(true), db.getClasses(true)]);
        res.json({ success: true, roles, classes });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal mengambil konfigurasi." }); }
});

app.get("/api/results", async (req, res) => {
    try {
        const s = await db.getElectionSettings();
        if (!s.published) return res.status(403).json({ success: false, message: "Hasil suara belum dipublikasikan." });
        res.json({ success: true, published: true, ...(await db.buildResultsData()) });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal mengambil hasil." }); }
});

// ─────────────────────────────────────────────
//  VOTING
// ─────────────────────────────────────────────
app.post("/api/vote/verify-code", async (req, res) => {
    const ip = getIp(req);
    if (!verifyRL.check(ip)) {
        return res.status(429).json({ success: false, message: "Terlalu banyak percobaan. Coba lagi 1 menit." });
    }
    try {
        const status = await db.getElectionStatus();
        if (status !== "OPEN") return res.status(403).json({ success: false, message: "Pemilihan belum dibuka." });

        const code = normalizeCode(req.body.code);
        if (!/^[A-Z0-9]{5}$/.test(code)) {
            verifyRL.fail(ip);
            return res.status(400).json({ success: false, message: "Kode pemilih harus 5 karakter." });
        }

        const voter = await db.getCodeByString(code);
        if (!voter) { verifyRL.fail(ip); return res.status(404).json({ success: false, message: "Kode pemilih tidak ditemukan." }); }
        if (voter.used) { verifyRL.fail(ip); return res.status(400).json({ success: false, message: "Kode pemilih sudah digunakan." }); }

        // Validasi role
        const roleData  = voter.voter_roles;
        const classData = voter.voter_classes;
        const deptData  = voter.voter_departments;

        if (voter.role_id) {
            if (roleData && !roleData.active) return res.status(403).json({ success: false, message: "Jenis pemilih tidak aktif." });
        }

        verifyRL.clear(ip);
        const voteToken = createVoteToken(voter.id, voter.role_id, voter.class_id, voter.department_id);

        res.json({
            success: true,
            voter: {
                voteToken,
                code:           voter.code,
                roleId:         voter.role_id   || null,
                role:           roleData?.name   || null,
                classId:        voter.class_id  || null,
                className:      classData?.name  || null,
                departmentId:   voter.department_id || null,
                departmentName: deptData?.name   || null
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal memverifikasi kode." });
    }
});

app.post("/api/vote", async (req, res) => {
    try {
        const status = await db.getElectionStatus();
        if (status !== "OPEN") return res.status(403).json({ success: false, message: "Pemilihan belum dibuka." });

        const voteToken   = String(req.body.voteToken || "").trim();
        const candidateId = Number(req.body.candidateId);
        const bodyRoleId  = Number(req.body.roleId);

        if (!voteToken)                    return res.status(400).json({ success: false, message: "Token tidak valid." });
        if (!Number.isInteger(candidateId)) return res.status(400).json({ success: false, message: "Data Paslon tidak valid." });

        const tokenData = verifyVoteToken(voteToken);
        if (!tokenData) return res.status(400).json({ success: false, message: "Token tidak valid atau kedaluwarsa. Masukkan kode kembali." });

        const codeId = tokenData.voterCodeId;

        // Resolve role
        let finalRoleId = tokenData.roleId;
        if (!finalRoleId) {
            if (!Number.isInteger(bodyRoleId) || bodyRoleId <= 0)
                return res.status(400).json({ success: false, message: "Jenis pemilih wajib dipilih." });
            const chosenRole = await db.getRoleById(bodyRoleId);
            if (!chosenRole) return res.status(404).json({ success: false, message: "Jenis pemilih tidak ditemukan." });
            if (!chosenRole.active) return res.status(400).json({ success: false, message: "Jenis pemilih tidak aktif." });
            finalRoleId = bodyRoleId;
        }

        // Cast vote via stored function (atomik di Supabase)
        const result = await db.castVote(codeId, candidateId, finalRoleId, tokenData.classId, tokenData.departmentId);

        if (result === "ALREADY_USED")   return res.status(400).json({ success: false, message: "Kode pemilih sudah digunakan." });
        if (result === "CODE_NOT_FOUND") return res.status(404).json({ success: false, message: "Data pemilih tidak ditemukan." });
        if (result !== "OK")             return res.status(500).json({ success: false, message: "Gagal mengirim suara." });

        res.json({ success: true, message: "Suara berhasil dikirim." });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Gagal mengirim suara." });
    }
});

// ─────────────────────────────────────────────
//  ADMIN — AUTH
// ─────────────────────────────────────────────
app.get("/api/admin/session", (req, res) => {
    if (!getAdminSession(req)) {
        return res.status(401).json({ success: false, authenticated: false });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, authenticated: true });
});

app.post("/api/admin/login", async (req, res) => {
    const ip = getIp(req);
    if (!loginRL.check(ip)) {
        return res.status(429).json({ success: false, message: "Terlalu banyak percobaan. Coba beberapa menit lagi." });
    }
    if (!checkAdminPassword(req)) {
        loginRL.fail(ip);
        await audit("LOGIN_FAIL", "admin login page", 0, req);
        return res.status(401).json({ success: false, message: "Password administrator salah." });
    }

    loginRL.clear(ip);
    setAdminSessionCookie(res);
    await audit("LOGIN_SUCCESS", "admin login page", 1, req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, message: "Login berhasil." });
});

app.post("/api/admin/logout", (req, res) => {
    clearAdminSessionCookie(res);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, message: "Logout berhasil." });
});

app.post("/api/admin/verify", async (req, res) => {
    const ip = getIp(req);
    if (!loginRL.check(ip)) return res.status(429).json({ success: false, message: "Terlalu banyak percobaan." });
    if (!checkAdminPassword(req)) {
        loginRL.fail(ip);
        await audit("LOGIN_FAIL", null, 0, req);
        return res.status(401).json({ success: false, message: "Password salah." });
    }
    loginRL.clear(ip);
    res.json({ success: true, message: "Password benar." });
});

// ─────────────────────────────────────────────
//  ADMIN — STATUS PEMILIHAN
// ─────────────────────────────────────────────
app.post("/api/election/ready", requireAdmin, async (req, res) => {
    try {
        if (await db.getElectionStatus() !== "DRAFT") return res.status(400).json({ success: false, message: "Hanya bisa dari status DRAFT." });
        const [cands, codes] = await Promise.all([
            db.getCandidates(),
            db.countActiveCodesOnly()
        ]);
        if (cands.length < 2) return res.status(400).json({ success: false, message: "Minimal 2 Paslon." });
        if (codes < 1)        return res.status(400).json({ success: false, message: "Minimal 1 kode pemilih." });
        await db.setElectionStatus("READY");
        await audit("STATUS_CHANGE", "DRAFT → READY", 1, req);
        res.json({ success: true, status: "READY", message: "Pemilihan berhasil disiapkan." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post("/api/election/open", requireAdmin, async (req, res) => {
    try {
        if (await db.getElectionStatus() !== "READY") return res.status(400).json({ success: false, message: "Hanya bisa dari status READY." });
        await db.setElectionStatus("OPEN");
        await audit("STATUS_CHANGE", "READY → OPEN", 1, req);
        res.json({ success: true, status: "OPEN", message: "Pemilihan berhasil dibuka." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post("/api/election/unlock", requireAdmin, async (req, res) => {
    try {
        if (await db.getElectionStatus() !== "READY") return res.status(400).json({ success: false, message: "Hanya bisa saat status READY." });
        await db.setElectionStatus("DRAFT");
        await audit("STATUS_CHANGE", "READY → DRAFT (unlock)", 1, req);
        res.json({ success: true, status: "DRAFT", message: "Konfigurasi berhasil dibuka kembali." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post("/api/election/close", requireAdmin, async (req, res) => {
    try {
        if (await db.getElectionStatus() !== "OPEN") return res.status(400).json({ success: false, message: "Hanya bisa saat status OPEN." });
        await db.setElectionStatus("CLOSED");
        await audit("STATUS_CHANGE", "OPEN → CLOSED", 1, req);
        res.json({ success: true, status: "CLOSED", message: "Pemilihan berhasil diselesaikan." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post("/api/election/reset", requireAdmin, async (req, res) => {
    try {
        if (await db.getElectionStatus() !== "CLOSED") return res.status(400).json({ success: false, message: "Reset hanya saat status CLOSED." });
        if (String(req.body.confirmPhrase || "").trim() !== "RESET PEMILIHAN")
            return res.status(400).json({ success: false, message: "Ketik RESET PEMILIHAN untuk mengonfirmasi." });

        const voteCount = await db.countVotes();
        const batchId   = crypto.randomBytes(8).toString("hex");

        // Arsip suara → hapus suara → hapus semua kode
        await db.archiveAndClearVotes(batchId, "election_reset");
        await db.deleteAllActiveCodes();

        await db.setElectionStatus("DRAFT");
        await db.setPublished(false);
        await audit("ELECTION_RESET", `${voteCount} suara diarsip (batch ${batchId})`, voteCount, req);

        res.json({ success: true, status: "DRAFT", message: "Pemilihan berhasil direset. Data suara diarsip." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post("/api/election/publish", requireAdmin, async (req, res) => {
    try {
        await db.setPublished(true);
        await audit("PUBLISH", "Hasil dipublikasikan", 1, req);
        res.json({ success: true, published: true, message: "Hasil suara berhasil dipublikasikan." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post("/api/election/unpublish", requireAdmin, async (req, res) => {
    try {
        await db.setPublished(false);
        await audit("UNPUBLISH", "Hasil disembunyikan", 1, req);
        res.json({ success: true, published: false, message: "Hasil suara disembunyikan." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

// ─────────────────────────────────────────────
//  ADMIN — HAPUS DATA SUARA
// ─────────────────────────────────────────────
app.post("/api/admin/votes/clear", requireAdmin, async (req, res) => {
    try {
        const status = await db.getElectionStatus();
        if (status === "OPEN" || status === "READY") {
            return res.status(403).json({ success: false, message: `Tidak bisa hapus data saat status ${status}.` });
        }
        if (String(req.body.confirmPhrase || "").trim() !== "HAPUS SEMUA SUARA")
            return res.status(400).json({ success: false, message: "Ketik HAPUS SEMUA SUARA untuk mengonfirmasi." });

        const voteCount = await db.countVotes();
        const batchId   = crypto.randomBytes(8).toString("hex");

        await db.archiveAndClearVotes(batchId, "manual_clear");
        await db.resetAllCodes();
        await audit("VOTES_CLEAR", `${voteCount} suara diarsip (batch ${batchId})`, voteCount, req);

        res.json({ success: true, votesArchived: voteCount, batchId, message: `${voteCount} suara diarsip. Kode direset.` });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.post("/api/admin/votes/restore-last", requireAdmin, async (req, res) => {
    try {
        const status = await db.getElectionStatus();
        if (status === "OPEN") return res.status(403).json({ success: false, message: "Tidak bisa restore saat OPEN." });
        const restored = await db.restoreLastBatch();
        if (restored === 0) return res.status(404).json({ success: false, message: "Tidak ada arsip untuk dipulihkan." });
        await audit("VOTES_RESTORE", `${restored} suara dipulihkan`, restored, req);
        res.json({ success: true, restored, message: `${restored} suara berhasil dipulihkan.` });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

app.get("/api/admin/votes/archive-info", requireAdmin, async (req, res) => {
    try {
        const raw = await db.getArchiveBatches();
        // Group by batch_id
        const byBatch = {};
        raw.forEach(r => {
            if (!byBatch[r.batch_id]) byBatch[r.batch_id] = { batch_id: r.batch_id, n: 0, archivedAt: r.archived_at, deleted_reason: r.deleted_reason };
            byBatch[r.batch_id].n++;
        });
        res.json({ success: true, batches: Object.values(byBatch).slice(0, 5) });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: e.message }); }
});

// ─────────────────────────────────────────────
//  ADMIN — HERO IMAGE
// ─────────────────────────────────────────────
app.post("/api/admin/hero-image", requireAdmin, upload.single("image"), async (req, res) => {
    let uploaded = null;
    try {
        if (!req.file) return res.status(400).json({ success: false, message: "File gambar belum dipilih." });
        const realExt = detectImageType(req.file.buffer);
        if (!realExt) return res.status(400).json({ success: false, message: "File bukan gambar valid." });

        const cur = await db.getElectionSettings();
        uploaded = await media.uploadImage(req.file.buffer, realExt, "hero");
        await db.setHeroImage(uploaded.publicUrl);

        if (cur.heroImage) {
            await media.removeImageByUrl(cur.heroImage).catch(err => console.error("[Storage:cleanup hero]", err.message));
        }
        res.json({ success: true, heroImage: uploaded.publicUrl });
    } catch (e) {
        console.error(e);
        if (uploaded?.objectPath) {
            await media.removeImageByPath(uploaded.objectPath).catch(() => {});
        }
        res.status(500).json({ success: false, message: "Gagal mengunggah gambar hero." });
    }
});

app.delete("/api/admin/hero-image", requireAdmin, async (req, res) => {
    try {
        const cur = await db.getElectionSettings();
        await db.setHeroImage(null);
        if (cur.heroImage) {
            await media.removeImageByUrl(cur.heroImage).catch(err => console.error("[Storage:cleanup hero]", err.message));
        }
        res.json({ success: true, message: "Gambar hero dihapus." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal menghapus gambar hero." }); }
});

// ─────────────────────────────────────────────
//  ADMIN — PASLON
// ─────────────────────────────────────────────
app.post("/api/admin/candidates", requireAdmin, requireDraft, async (req, res) => {
    try {
        const number   = Number(req.body.number);
        const name     = String(req.body.name     || "").trim();
        const chairman = String(req.body.chairman || "").trim();
        const vice     = String(req.body.vice     || "").trim();
        const photo    = req.body.photo || null;
        if (!Number.isInteger(number) || number <= 0) return res.status(400).json({ success: false, message: "Nomor Paslon tidak valid." });
        if (!name || !chairman || !vice) return res.status(400).json({ success: false, message: "Nama, Ketua, dan Wakil wajib diisi." });
        if (await db.candidateNumberExists(number)) return res.status(400).json({ success: false, message: "Nomor Paslon sudah digunakan." });
        const candidate = await db.insertCandidate(number, name, chairman, vice, photo);
        res.json({ success: true, candidate });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal menambahkan Paslon." }); }
});

app.post("/api/admin/candidates/upload/:number", requireAdmin, requireDraft, upload.single("photo"), async (req, res) => {
    let uploaded = null;
    try {
        const number = Number(req.params.number);
        if (!req.file) return res.status(400).json({ success: false, message: "Foto belum dipilih." });
        const realExt = detectImageType(req.file.buffer);
        if (!realExt) return res.status(400).json({ success: false, message: "File bukan gambar valid." });

        const candidate = await db.getCandidateByNumber(number);
        if (!candidate) return res.status(404).json({ success: false, message: "Paslon tidak ditemukan." });

        uploaded = await media.uploadImage(req.file.buffer, realExt, `candidates/${candidate.id}`);
        await db.updateCandidate(candidate.id, { photo: uploaded.publicUrl });

        if (candidate.photo) {
            await media.removeImageByUrl(candidate.photo).catch(err => console.error("[Storage:cleanup candidate]", err.message));
        }
        res.json({ success: true, photo: uploaded.publicUrl });
    } catch (e) {
        console.error(e);
        if (uploaded?.objectPath) {
            await media.removeImageByPath(uploaded.objectPath).catch(() => {});
        }
        res.status(500).json({ success: false, message: "Gagal mengunggah foto." });
    }
});

app.put("/api/admin/candidates/:id", requireAdmin, requireDraft, async (req, res) => {
    try {
        const id       = Number(req.params.id);
        const number   = Number(req.body.number);
        const name     = String(req.body.name     || "").trim();
        const chairman = String(req.body.chairman || "").trim();
        const vice     = String(req.body.vice     || "").trim();
        const photo    = req.body.photo;
        const existing = await db.getCandidateById(id);
        if (!existing) return res.status(404).json({ success: false, message: "Paslon tidak ditemukan." });
        if (!Number.isInteger(number) || number <= 0) return res.status(400).json({ success: false, message: "Nomor tidak valid." });
        if (!name || !chairman || !vice) return res.status(400).json({ success: false, message: "Nama, Ketua, dan Wakil wajib diisi." });
        if (await db.candidateNumberExists(number, id)) return res.status(400).json({ success: false, message: "Nomor sudah digunakan." });
        const finalPhoto = photo === undefined ? existing.photo : (photo || null);
        const candidate  = await db.updateCandidate(id, { number, name, chairman, vice, photo: finalPhoto });
        res.json({ success: true, candidate });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal memperbarui Paslon." }); }
});

app.delete("/api/admin/candidates/:id", requireAdmin, requireDraft, async (req, res) => {
    try {
        const id        = Number(req.params.id);
        const candidate = await db.getCandidateById(id);
        if (!candidate) return res.status(404).json({ success: false, message: "Paslon tidak ditemukan." });
        if (await db.countVotesForCandidate(id) > 0) return res.status(400).json({ success: false, message: "Paslon yang sudah punya suara tidak dapat dihapus." });
        await db.deleteCandidate(id);
        if (candidate.photo) {
            await media.removeImageByUrl(candidate.photo).catch(err => console.error("[Storage:cleanup candidate]", err.message));
        }
        res.json({ success: true, message: "Paslon berhasil dihapus." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal menghapus Paslon." }); }
});

// ─────────────────────────────────────────────
//  ADMIN — KONFIGURASI PEMILIH
// ─────────────────────────────────────────────
app.get("/api/admin/voter-config", requireAdmin, async (req, res) => {
    try {
        const [roles, classes, departments, rawCodes] = await Promise.all([
            db.getRoles(), db.getClasses(), db.getDepartments(), db.getCodesWithMeta()
        ]);
        // Normalise kode agar field-nya konsisten dengan format lama
        const codes = rawCodes.map(c => ({
            id:           c.id,
            code:         c.code,
            roleId:       c.role_id,
            role:         c.voter_roles?.name    || null,
            classId:      c.class_id,
            className:    c.voter_classes?.name  || null,
            departmentId: c.department_id,
            department:   c.voter_departments?.name || null,
            used:         c.used,
            createdAt:    c.created_at,
            usedAt:       c.used_at
        }));
        res.json({ success: true, roles, classes, departments, codes });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal mengambil konfigurasi." }); }
});

app.put("/api/admin/voter-roles/:id", requireAdmin, requireDraft, async (req, res) => {
    try {
        const id     = Number(req.params.id);
        const active = req.body.active === true || req.body.active === 1 || req.body.active === "1";
        if (!await db.getRoleById(id)) return res.status(404).json({ success: false, message: "Jenis pemilih tidak ditemukan." });
        await db.updateRoleActive(id, active);
        res.json({ success: true, role: await db.getRoleById(id) });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal mengubah status." }); }
});

app.post("/api/admin/voter-classes", requireAdmin, requireDraft, async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        if (!name) return res.status(400).json({ success: false, message: "Nama kelas wajib diisi." });
        const cls = await db.insertClass(name);
        res.json({ success: true, class: cls });
    } catch (e) {
        if (e.message.includes("unique") || e.message.includes("duplicate"))
            return res.status(400).json({ success: false, message: "Kelas tersebut sudah ada." });
        console.error(e); res.status(500).json({ success: false, message: "Gagal menambahkan kelas." });
    }
});

app.delete("/api/admin/voter-classes/:id", requireAdmin, requireDraft, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!await db.getClassById(id)) return res.status(404).json({ success: false, message: "Kelas tidak ditemukan." });
        if (await db.classIsUsed(id)) return res.status(400).json({ success: false, message: "Kelas yang sudah digunakan tidak dapat dihapus." });
        await db.deleteClass(id);
        res.json({ success: true, message: "Kelas berhasil dihapus." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal menghapus kelas." }); }
});

app.post("/api/admin/voter-departments", requireAdmin, requireDraft, async (req, res) => {
    try {
        const classId = Number(req.body.class_id ?? req.body.classId);
        const name    = String(req.body.name || "").trim();
        if (!Number.isInteger(classId)) return res.status(400).json({ success: false, message: "Kelas tidak valid." });
        if (!name) return res.status(400).json({ success: false, message: "Nama jurusan wajib diisi." });
        const cls = await db.getClassById(classId);
        if (!cls) return res.status(404).json({ success: false, message: "Kelas tidak ditemukan." });
        if (!cls.active) return res.status(400).json({ success: false, message: "Kelas tidak aktif." });
        const dept = await db.insertDepartment(classId, name);
        res.json({ success: true, department: dept });
    } catch (e) {
        if (e.message.includes("unique") || e.message.includes("duplicate"))
            return res.status(400).json({ success: false, message: "Jurusan tersebut sudah ada." });
        console.error(e); res.status(500).json({ success: false, message: "Gagal menambahkan jurusan." });
    }
});

app.delete("/api/admin/voter-departments/:id", requireAdmin, requireDraft, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (await db.deptIsUsed(id)) return res.status(400).json({ success: false, message: "Jurusan yang sudah digunakan tidak dapat dihapus." });
        await db.deleteDepartment(id);
        res.json({ success: true, message: "Jurusan berhasil dihapus." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal menghapus jurusan." }); }
});

// ─────────────────────────────────────────────
//  ADMIN — KODE PEMILIH
// ─────────────────────────────────────────────
app.post("/api/admin/voter-codes/generate", requireAdmin, requireDraft, async (req, res) => {
    try {
        const roleId = Number(req.body.role_id ?? req.body.roleId);
        const rawClassId = req.body.class_id ?? req.body.classId;
        const classId = rawClassId === undefined || rawClassId === null || rawClassId === ""
            ? null
            : Number(rawClassId);
        const amount = Number(req.body.amount ?? req.body.quantity ?? req.body.count);

        if (!Number.isInteger(roleId) || roleId <= 0) return res.status(400).json({ success: false, message: "Jenis pemilih wajib dipilih." });
        if (!Number.isInteger(amount) || amount < 1 || amount > MAX_GENERATE_CODES) {
            return res.status(400).json({ success: false, message: `Jumlah kode harus 1–${MAX_GENERATE_CODES}.` });
        }
        if (classId !== null && (!Number.isInteger(classId) || classId <= 0)) {
            return res.status(400).json({ success: false, message: "Kelas tidak valid. Pilih satu kelas spesifik." });
        }

        const role = await db.getRoleById(roleId);
        if (!role) return res.status(404).json({ success: false, message: "Jenis pemilih tidak ditemukan." });
        if (!role.active) return res.status(400).json({ success: false, message: "Jenis pemilih tidak aktif." });

        if (role.name === "SISWA" && classId === null) {
            return res.status(400).json({ success: false, message: "Kelas wajib dipilih untuk SISWA." });
        }
        if (classId !== null) {
            if (!await db.getClassById(classId)) return res.status(404).json({ success: false, message: "Kelas tidak ditemukan." });
        }

        const existingSet = await db.getAllExistingCodes();
        const rows = [];
        for (let i = 0; i < amount; i++) {
            rows.push({ code: generateCode(existingSet), role_id: roleId, class_id: classId || null, department_id: null, used: 0 });
        }
        await db.insertCodes(rows);
        await audit("GENERATE_CODES", `${amount} kode role=${roleId} class=${classId}`, amount, req);
        res.json({ success: true, amount: rows.length, codes: rows.map(r => r.code) });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal membuat kode." }); }
});

app.delete("/api/admin/voter-codes", requireAdmin, requireDraft, async (req, res) => {
    try {
        const body      = req.body || {};
        const deleteAll = body.all === true || body.all === "true";
        const ids       = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
        if (!deleteAll && !ids.length) return res.status(400).json({ success: false, message: "Tidak ada kode yang dipilih." });
        const deleted = deleteAll ? await db.deleteAllActiveCodes() : await db.deleteCodesByIds(ids);
        await audit("DELETE_CODES", deleteAll ? "hapus semua aktif" : `hapus ${ids.length}`, deleted, req);
        res.json({ success: true, deleted, message: `${deleted} kode berhasil dihapus.` });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal menghapus kode." }); }
});

app.delete("/api/admin/voter-codes/:id", requireAdmin, requireDraft, async (req, res) => {
    try {
        const id   = Number(req.params.id);
        const code = await db.getCodeById(id);
        if (!code) return res.status(404).json({ success: false, message: "Kode tidak ditemukan." });
        if (code.used) return res.status(400).json({ success: false, message: "Kode yang sudah digunakan tidak dapat dihapus." });
        await db.deleteCodeById(id);
        res.json({ success: true, message: "Kode berhasil dihapus." });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal menghapus kode." }); }
});

// ─────────────────────────────────────────────
//  ADMIN — HASIL & LOG
// ─────────────────────────────────────────────
app.get("/api/admin/results", requireAdmin, async (req, res) => {
    try {
        res.json({ success: true, ...(await db.buildAdminResultsData()) });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal mengambil hasil." }); }
});

app.get("/api/admin/audit-log", requireAdmin, async (req, res) => {
    try {
        res.json({ success: true, logs: await db.getAuditLogs() });
    } catch (e) { console.error(e); res.status(500).json({ success: false, message: "Gagal mengambil log." }); }
});

// ─────────────────────────────────────────────
//  ERROR HANDLER
// ─────────────────────────────────────────────
app.use("/api", (req, res) => res.status(404).json({ success: false, message: "Endpoint tidak ditemukan." }));

app.use((err, req, res, next) => {
    console.error(err);
    if (err instanceof multer.MulterError)
        return res.status(400).json({ success: false, message: "Upload gagal: " + err.message });
    if (err?.isValidation)
        return res.status(400).json({ success: false, message: err.message });
    res.status(500).json({ success: false, message: err.message || "Terjadi kesalahan server." });
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`PILKETOS berjalan di http://localhost:${PORT}`));
}

module.exports = app;
