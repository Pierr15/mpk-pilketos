"use strict";

const crypto = require("crypto");
const supabase = require("./supabase");

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "pilketos-assets";

function sanitizeFolder(folder) {
    return String(folder || "misc")
        .toLowerCase()
        .replace(/[^a-z0-9/_-]/g, "-")
        .replace(/\/+/g, "/")
        .replace(/^\/+|\/+$/g, "") || "misc";
}

function extensionToMime(ext) {
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    return "application/octet-stream";
}

async function uploadImage(buffer, ext, folder) {
    const safeFolder = sanitizeFolder(folder);
    const fileName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
    const objectPath = `${safeFolder}/${fileName}`;

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(objectPath, buffer, {
            contentType: extensionToMime(ext),
            cacheControl: "3600",
            upsert: false
        });

    if (error) throw new Error(`[Storage:upload] ${error.message}`);

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
    if (!data?.publicUrl) throw new Error("Gagal membuat public URL untuk gambar.");

    return { publicUrl: data.publicUrl, objectPath };
}

function objectPathFromPublicUrl(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const marker = `/storage/v1/object/public/${BUCKET}/`;
        const idx = parsed.pathname.indexOf(marker);
        if (idx === -1) return null;
        return decodeURIComponent(parsed.pathname.slice(idx + marker.length));
    } catch {
        return null;
    }
}

async function removeImageByPath(objectPath) {
    if (!objectPath) return false;
    const { error } = await supabase.storage.from(BUCKET).remove([objectPath]);
    if (error) throw new Error(`[Storage:remove] ${error.message}`);
    return true;
}

async function removeImageByUrl(url) {
    const objectPath = objectPathFromPublicUrl(url);
    if (!objectPath) return false;
    return removeImageByPath(objectPath);
}

module.exports = {
    BUCKET,
    uploadImage,
    removeImageByPath,
    removeImageByUrl,
    objectPathFromPublicUrl
};
