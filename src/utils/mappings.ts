import type { Mapping, MappingStore, Platform } from "../types";

let cachedMappings: MappingStore | null = null;

export function invalidateMappingsCache(): void {
  cachedMappings = null;
}

export async function getMappings(): Promise<MappingStore> {
  if (cachedMappings) return cachedMappings;

  const url = chrome.runtime.getURL("mappings.json");
  const res = await fetch(url);
  const bundled = (await res.json()) as MappingStore;

  const stored = await chrome.storage.local.get([
    "communityMappings",
    "customMappings",
  ]);

  // Merge order: bundled < community < custom (custom wins per-QID)
  for (const key of ["communityMappings", "customMappings"] as const) {
    if (stored[key]) {
      const layer = stored[key] as MappingStore;
      for (const platform of ["passMed", "quesmed"] as const) {
        if (layer[platform]) {
          bundled[platform] = {
            ...(bundled[platform] || {}),
            ...layer[platform],
          };
        }
      }
    }
  }

  cachedMappings = bundled;
  return cachedMappings;
}

type CustomMappings = Record<string, Record<string, Mapping>>;

function getCustomMaps(stored: { customMappings?: unknown }): CustomMappings {
  return (stored.customMappings as CustomMappings) || { passMed: {}, quesmed: {} };
}

export async function saveMapping(
  platform: Platform,
  qid: string,
  noteId: number,
  topic?: string
): Promise<void> {
  const nid = Number(noteId);
  const stored = await chrome.storage.local.get("customMappings");
  const maps = getCustomMaps(stored);
  if (!maps[platform]) maps[platform] = {};

  const existing = maps[platform][String(qid)] as Mapping | undefined;
  if (existing) {
    const ids = new Set((existing.noteIds ?? []).map(Number));
    ids.add(nid);
    existing.noteIds = [...ids];
    existing.search = null;
  } else {
    maps[platform][String(qid)] = {
      noteIds: [nid],
      topic,
      contributor: "self",
      autoMapped: true,
    };
  }

  await chrome.storage.local.set({ customMappings: maps });
  cachedMappings = null;
}

export async function removeFromMapping(
  platform: Platform,
  qid: string,
  noteId: number
): Promise<void> {
  const stored = await chrome.storage.local.get("customMappings");
  const maps = getCustomMaps(stored);
  const entry = (maps[platform] ?? {})[String(qid)] as Mapping | undefined;

  if (entry) {
    entry.noteIds = (entry.noteIds ?? [])
      .map(Number)
      .filter((id: number) => id !== Number(noteId));
    if (!entry.noteIds.length && !entry.search) {
      delete maps[platform][String(qid)];
    }
  }

  await chrome.storage.local.set({ customMappings: maps });
  cachedMappings = null;
}
