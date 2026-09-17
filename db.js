"use strict";

/**
 * db.js — Lapisan akses database Supabase
 * Semua fungsi async, menggantikan driver SQLite lokal yang sebelumnya sync.
 * server.js memanggil fungsi-fungsi ini lewat await.
 */

const supabase = require("./supabase");

// ─────────────────────────────────────────────
//  HELPER: error check
// ─────────────────────────────────────────────
function check(result, label) {
    if (result.error) {
        const msg = `[DB:${label}] ${result.error.message}`;
        console.error(msg);
        throw new Error(msg);
    }
    return result.data;
}

// ─────────────────────────────────────────────
//  ELECTION SETTINGS
// ─────────────────────────────────────────────
async function getElectionSettings() {
    const r = await supabase
        .from("election_settings")
        .select("status, published, hero_image")
        .eq("id", 1)
        .single();
    const data = check(r, "getElectionSettings");
    return {
        status:    data.status,
        published: data.published,
        heroImage: data.hero_image || null
    };
}

async function getElectionStatus() {
    const s = await getElectionSettings();
    return s.status;
}

async function setElectionStatus(status) {
    check(
        await supabase
            .from("election_settings")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("id", 1),
        "setElectionStatus"
    );
}

async function setPublished(val) {
    check(
        await supabase
            .from("election_settings")
            .update({ published: val ? 1 : 0 })
            .eq("id", 1),
        "setPublished"
    );
}

async function setHeroImage(url) {
    check(
        await supabase
            .from("election_settings")
            .update({ hero_image: url })
            .eq("id", 1),
        "setHeroImage"
    );
}

// ─────────────────────────────────────────────
//  CANDIDATES
// ─────────────────────────────────────────────
async function getCandidates() {
    return check(
        await supabase.from("candidates").select("*").order("number"),
        "getCandidates"
    );
}

async function getCandidateById(id) {
    const r = await supabase.from("candidates").select("*").eq("id", id).single();
    return r.data || null;
}

async function getCandidateByNumber(number) {
    const r = await supabase.from("candidates").select("*").eq("number", number).single();
    return r.data || null;
}

async function candidateNumberExists(number, excludeId = null) {
    let q = supabase.from("candidates").select("id").eq("number", number);
    if (excludeId) q = q.neq("id", excludeId);
    const r = await q;
    return r.data && r.data.length > 0;
}

async function insertCandidate(number, name, chairman, vice, photo) {
    const r = await supabase
        .from("candidates")
        .insert({ number, name, chairman, vice, photo: photo || null })
        .select()
        .single();
    check(r, "insertCandidate");
    return r.data;
}

async function updateCandidate(id, fields) {
    const r = await supabase
        .from("candidates")
        .update(fields)
        .eq("id", id)
        .select()
        .single();
    check(r, "updateCandidate");
    return r.data;
}

async function deleteCandidate(id) {
    check(
        await supabase.from("candidates").delete().eq("id", id),
        "deleteCandidate"
    );
}

async function countVotesForCandidate(candidateId) {
    const r = await supabase
        .from("votes")
        .select("id", { count: "exact", head: true })
        .eq("candidate_id", candidateId);
    return r.count || 0;
}

// ─────────────────────────────────────────────
//  VOTER ROLES
// ─────────────────────────────────────────────
async function getRoles(activeOnly = false) {
    let q = supabase.from("voter_roles").select("id, name, active");
    if (activeOnly) q = q.eq("active", 1);
    const data = check(await q, "getRoles");
    // Urutkan: SISWA, GURU, STAFF, lainnya
    const order = { SISWA: 1, GURU: 2, STAFF: 3 };
    return data.sort((a, b) => (order[a.name] || 99) - (order[b.name] || 99));
}

async function getRoleById(id) {
    const r = await supabase.from("voter_roles").select("id, name, active").eq("id", id).single();
    return r.data || null;
}

async function updateRoleActive(id, active) {
    check(
        await supabase.from("voter_roles").update({ active: active ? 1 : 0 }).eq("id", id),
        "updateRoleActive"
    );
}

// ─────────────────────────────────────────────
//  VOTER CLASSES
// ─────────────────────────────────────────────
async function getClasses(activeOnly = false) {
    let q = supabase.from("voter_classes").select("id, name, active").order("id");
    if (activeOnly) q = q.eq("active", 1);
    return check(await q, "getClasses");
}

async function getClassById(id) {
    const r = await supabase.from("voter_classes").select("id, name, active").eq("id", id).single();
    return r.data || null;
}

async function insertClass(name) {
    const r = await supabase
        .from("voter_classes")
        .insert({ name, active: 1 })
        .select()
        .single();
    check(r, "insertClass");
    return r.data;
}

async function deleteClass(id) {
    check(
        await supabase.from("voter_classes").delete().eq("id", id),
        "deleteClass"
    );
}

async function classIsUsed(id) {
    const [c1, c2] = await Promise.all([
        supabase.from("voter_codes").select("id", { count: "exact", head: true }).eq("class_id", id),
        supabase.from("votes").select("id", { count: "exact", head: true }).eq("class_id", id)
    ]);
    return (c1.count || 0) + (c2.count || 0) > 0;
}

// ─────────────────────────────────────────────
//  VOTER DEPARTMENTS
// ─────────────────────────────────────────────
async function getDepartments() {
    return check(
        await supabase
            .from("voter_departments")
            .select("id, class_id, name, active, voter_classes(name, active)")
            .order("class_id")
            .order("name"),
        "getDepartments"
    );
}

async function insertDepartment(classId, name) {
    const r = await supabase
        .from("voter_departments")
        .insert({ class_id: classId, name, active: 1 })
        .select()
        .single();
    check(r, "insertDepartment");
    return r.data;
}

async function deleteDepartment(id) {
    check(
        await supabase.from("voter_departments").delete().eq("id", id),
        "deleteDepartment"
    );
}

async function deptIsUsed(id) {
    const [c1, c2] = await Promise.all([
        supabase.from("voter_codes").select("id", { count: "exact", head: true }).eq("department_id", id),
        supabase.from("votes").select("id", { count: "exact", head: true }).eq("department_id", id)
    ]);
    return (c1.count || 0) + (c2.count || 0) > 0;
}

// ─────────────────────────────────────────────
//  VOTER CODES
// ─────────────────────────────────────────────
async function getCodesWithMeta() {
    return check(
        await supabase
            .from("voter_codes")
            .select(`
                id, code, used, created_at, used_at,
                role_id, class_id, department_id,
                voter_roles(name),
                voter_classes(name),
                voter_departments(name)
            `)
            .order("id", { ascending: false }),
        "getCodesWithMeta"
    );
}

async function getAllExistingCodes() {
    const data = check(
        await supabase.from("voter_codes").select("code"),
        "getAllExistingCodes"
    );
    return new Set(data.map(r => r.code));
}

async function insertCodes(rows) {
    // rows = [{ code, role_id, class_id, department_id }]
    check(
        await supabase.from("voter_codes").insert(rows),
        "insertCodes"
    );
}

async function getCodeByString(code) {
    const r = await supabase
        .from("voter_codes")
        .select(`
            id, code, used,
            role_id, class_id, department_id,
            voter_roles(id, name, active),
            voter_classes(id, name, active),
            voter_departments(id, name, active, class_id)
        `)
        .eq("code", code)
        .single();
    return r.data || null;
}

async function getCodeById(id) {
    const r = await supabase
        .from("voter_codes")
        .select(`
            id, used, role_id, class_id, department_id,
            voter_roles(name, active),
            voter_classes(active),
            voter_departments(active)
        `)
        .eq("id", id)
        .single();
    return r.data || null;
}

async function deleteCodeById(id) {
    check(
        await supabase.from("voter_codes").delete().eq("id", id),
        "deleteCodeById"
    );
}

async function deleteAllActiveCodes() {
    const r = await supabase.from("voter_codes").delete().eq("used", 0).select("id");
    check(r, "deleteAllActiveCodes");
    return r.data ? r.data.length : 0;
}

async function deleteCodesByIds(ids) {
    const r = await supabase
        .from("voter_codes")
        .delete()
        .in("id", ids)
        .eq("used", 0)
        .select("id");
    check(r, "deleteCodesByIds");
    return r.data ? r.data.length : 0;
}

async function countCodes() {
    const r = await supabase
        .from("voter_codes")
        .select("used", { count: "exact" });
    const all  = r.data || [];
    const used = all.filter(c => c.used === 1).length;
    return { total: all.length, used, active: all.length - used };
}

async function countActiveCodesOnly() {
    const r = await supabase
        .from("voter_codes")
        .select("id", { count: "exact", head: true })
        .eq("used", 0);
    return r.count || 0;
}

async function resetAllCodes() {
    check(
        await supabase
            .from("voter_codes")
            .update({ used: 0, used_at: null })
            .neq("id", 0),   // update semua baris
        "resetAllCodes"
    );
}

// ─────────────────────────────────────────────
//  VOTES — cast (pakai stored function di Supabase)
// ─────────────────────────────────────────────
async function castVote(codeId, candidateId, roleId, classId, deptId) {
    const r = await supabase.rpc("cast_vote", {
        p_code_id:      codeId,
        p_candidate_id: candidateId,
        p_role_id:      roleId  || null,
        p_class_id:     classId || null,
        p_dept_id:      deptId  || null
    });
    if (r.error) throw new Error(r.error.message);
    return r.data; // 'OK' | 'ALREADY_USED' | 'CODE_NOT_FOUND'
}

async function countVotes() {
    const r = await supabase
        .from("votes")
        .select("id", { count: "exact", head: true });
    return r.count || 0;
}

// ─────────────────────────────────────────────
//  VOTES — archive & restore
// ─────────────────────────────────────────────
async function archiveAndClearVotes(batchId, reason) {
    const r = await supabase.rpc("archive_and_clear_votes", {
        p_batch_id: batchId,
        p_reason: reason
    });
    if (r.error) throw new Error(`[DB:archiveAndClearVotes] ${r.error.message}`);
    return Number(r.data || 0);
}

async function restoreLastBatch() {
    const r = await supabase.rpc("restore_last_vote_batch");
    if (r.error) throw new Error(`[DB:restoreLastBatch] ${r.error.message}`);
    return Number(r.data || 0);
}

async function getArchiveBatches() {
    return check(
        await supabase
            .from("votes_archive")
            .select("batch_id, archived_at, deleted_reason")
            .order("archived_at", { ascending: false }),
        "getArchiveBatches"
    );
}

// ─────────────────────────────────────────────
//  RESULTS
// ─────────────────────────────────────────────
async function buildResultsData() {
    const [candRows, roleRows, classRows, siswaRole] = await Promise.all([
        supabase.from("votes").select("candidate_id, candidates(id, number, name)"),
        supabase.from("votes").select("role_id, voter_roles(id, name)"),
        supabase.from("votes").select("class_id, role_id, voter_roles(name)"),
        supabase.from("voter_roles").select("id").eq("name", "SISWA").single()
    ]);

    // --- Kandidat ---
    const allCandidates = check(
        await supabase.from("candidates").select("id, number, name").order("number"),
        "results:candidates"
    );
    const voteByCand = {};
    (candRows.data || []).forEach(v => {
        voteByCand[v.candidate_id] = (voteByCand[v.candidate_id] || 0) + 1;
    });
    const candidates = allCandidates.map(c => ({
        ...c,
        total: voteByCand[c.id] || 0
    }));

    // --- Roles ---
    const allRoles = await getRoles();
    const voteByRole = {};
    (roleRows.data || []).forEach(v => {
        voteByRole[v.role_id] = (voteByRole[v.role_id] || 0) + 1;
    });
    const roles = allRoles.map(r => ({
        id: r.id, role: r.name,
        total: voteByRole[r.id] || 0
    }));

    // --- Non-students ---
    const nonStudents = roles
        .filter(r => r.role.toUpperCase() !== "SISWA")
        .map(r => ({ id: r.id, role: r.role, displayName: r.role, total: r.total }));

    // --- Siswa per kelas ---
    const allClasses = await getClasses();
    const siswaRoleId = siswaRole.data?.id;
    const voteByClass = {};
    let unclassedSiswa = 0;
    (classRows.data || []).forEach(v => {
        if (v.role_id !== siswaRoleId) return;
        if (v.class_id) {
            voteByClass[v.class_id] = (voteByClass[v.class_id] || 0) + 1;
        } else {
            unclassedSiswa++;
        }
    });
    const studentClasses = allClasses.map(c => ({
        id: c.id, name: c.name, displayName: c.name,
        total: voteByClass[c.id] || 0
    }));
    if (unclassedSiswa > 0) {
        studentClasses.push({ id: 0, name: "Tanpa Kelas", displayName: "Siswa (Tanpa Kelas)", total: unclassedSiswa });
    }

    const totalVotes = (candRows.data || []).length;

    return { totalVotes, candidates, roles, nonStudents, studentClasses };
}

async function buildAdminResultsData() {
    const base = await buildResultsData();

    // Suara per kelas (semua role)
    const allVotes = check(
        await supabase.from("votes").select("class_id"),
        "adminResults:allVotes"
    );
    const allClasses = await getClasses();
    const voteByClassAll = {};
    allVotes.forEach(v => {
        if (v.class_id) voteByClassAll[v.class_id] = (voteByClassAll[v.class_id] || 0) + 1;
    });
    const classes = allClasses.map(c => ({
        id: c.id, name: c.name,
        total: voteByClassAll[c.id] || 0
    }));

    // Suara per jurusan
    const allDepts  = await getDepartments();
    const deptVotes = check(
        await supabase.from("votes").select("department_id"),
        "adminResults:deptVotes"
    );
    const voteByDept = {};
    deptVotes.forEach(v => {
        if (v.department_id) voteByDept[v.department_id] = (voteByDept[v.department_id] || 0) + 1;
    });
    const departments = allDepts.map(d => ({
        id: d.id, name: d.name,
        className: d.voter_classes?.name || "",
        total: voteByDept[d.id] || 0
    }));

    return { ...base, classes, departments };
}

// ─────────────────────────────────────────────
//  AUDIT LOG
// ─────────────────────────────────────────────
async function writeAuditLog(action, detail, rowsAffected, ip, status) {
    try {
        await supabase.from("admin_log").insert({
            action:          String(action).substring(0, 100),
            detail:          detail ? String(detail).substring(0, 500) : null,
            election_status: status || null,
            rows_affected:   Number(rowsAffected) || 0,
            ip:              ip || null
        });
    } catch (e) { console.error("[audit]", e.message); }
}

async function getAuditLogs() {
    return check(
        await supabase
            .from("admin_log")
            .select("id, action, detail, election_status, rows_affected, ip, created_at")
            .order("id", { ascending: false })
            .limit(100),
        "getAuditLogs"
    );
}

// ─────────────────────────────────────────────
//  EXPORT
// ─────────────────────────────────────────────
module.exports = {
    // election
    getElectionSettings, getElectionStatus, setElectionStatus, setPublished, setHeroImage,
    // candidates
    getCandidates, getCandidateById, getCandidateByNumber,
    candidateNumberExists, insertCandidate, updateCandidate, deleteCandidate, countVotesForCandidate,
    // roles
    getRoles, getRoleById, updateRoleActive,
    // classes
    getClasses, getClassById, insertClass, deleteClass, classIsUsed,
    // departments
    getDepartments, insertDepartment, deleteDepartment, deptIsUsed,
    // codes
    getCodesWithMeta, getAllExistingCodes, insertCodes, getCodeByString, getCodeById,
    deleteCodeById, deleteAllActiveCodes, deleteCodesByIds, countCodes, countActiveCodesOnly, resetAllCodes,
    // votes
    castVote, countVotes, archiveAndClearVotes, restoreLastBatch, getArchiveBatches,
    // results
    buildResultsData, buildAdminResultsData,
    // audit
    writeAuditLog, getAuditLogs
};
