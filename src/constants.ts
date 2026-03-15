export const ANKICONNECT_URL = "http://localhost:8765";
export const DECK_NAME = "!Spranki Clinical";
export const CACHE_TTL = 60 * 60 * 1000; // 1 hour
export const MAPPING_VERSION = "0.1.0";

// ── Supabase (Phase B) ────────────────────────────────────────
// Fill these in after creating your project at supabase.com.
// The anon key is safe to embed — RLS enforces read-only public / anon-insert only.
export const SUPABASE_URL = "https://ctwzdrxzidpgulykkiog.supabase.co"
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0d3pkcnh6aWRwZ3VseWtraW9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NzczNzEsImV4cCI6MjA4OTA1MzM3MX0.TXUiFR2mCexFbjTXkOvuCV8g5h77XMQ6bEZiS1T6eN4";

export const COMMUNITY_SYNC_LIMIT = 500; // max rows fetched per sync
export const COMMUNITY_SYNC_ALARM = "spranki-community-sync";
export const COMMUNITY_SYNC_INTERVAL_HOURS = 24;
