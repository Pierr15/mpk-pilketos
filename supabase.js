"use strict";

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
        "SUPABASE_URL dan SUPABASE_SECRET_KEY wajib diatur. " +
        "SUPABASE_SERVICE_KEY tetap didukung sementara untuk kompatibilitas legacy."
    );
}

module.exports = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
    }
});
