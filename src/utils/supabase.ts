import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  COMMUNITY_SYNC_LIMIT,
} from "../constants";
import type { Platform } from "../types";

function getHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

function isConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export interface CommunityRow {
  platform: string;
  qid: string;
  note_id: number;
  topic: string | null;
  confirmed_count: number;
}

/**
 * Upload a confirmed mapping to Supabase.
 * Fire-and-forget — all errors swallowed, never blocks the user.
 */
export async function uploadMapping(
  platform: Platform,
  qid: string,
  noteId: number,
  topic?: string
): Promise<void> {
  if (!isConfigured()) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_community_mapping`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        p_platform: platform,
        p_qid: qid,
        p_note_id: noteId,
        p_topic: topic ?? null,
      }),
    });
  } catch {
    // Silently swallow — community upload must never break the save flow
  }
}

/**
 * Live-fetch community noteIds for a single (platform, qid).
 * Used by LOOKUP_CARDS as a last-resort before falling through to AI/fuzzy.
 */
export async function fetchMappingForQID(
  platform: Platform,
  qid: string
): Promise<number[]> {
  if (!isConfigured()) return [];
  try {
    const params = new URLSearchParams({
      platform: `eq.${platform}`,
      qid: `eq.${qid}`,
      select: "note_id",
      order: "confirmed_count.desc",
    });
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/community_mappings?${params}`,
      { headers: getHeaders() }
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ note_id: number }>;
    return rows.map((r) => r.note_id);
  } catch {
    return [];
  }
}

/**
 * Bulk-fetch the top-N most confirmed community mappings.
 * Called during background periodic sync to seed local cache.
 */
export async function fetchTopMappings(): Promise<CommunityRow[]> {
  if (!isConfigured()) return [];
  try {
    const params = new URLSearchParams({
      select: "platform,qid,note_id,topic,confirmed_count",
      order: "confirmed_count.desc",
      limit: String(COMMUNITY_SYNC_LIMIT),
    });
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/community_mappings?${params}`,
      { headers: getHeaders() }
    );
    if (!res.ok) return [];
    return (await res.json()) as CommunityRow[];
  } catch {
    return [];
  }
}
