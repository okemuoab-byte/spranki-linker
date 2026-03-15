import { ANKICONNECT_URL } from "../constants";
import type { AnkiNoteInfo, AnkiCardInfo } from "../types";

export async function ankiConnect<T = unknown>(
  action: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  try {
    const res = await fetch(ANKICONNECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, params }),
    });
    const data = (await res.json()) as { error?: string; result: T };
    if (data.error) throw new Error(data.error);
    return data.result;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
      throw new Error("ANKICONNECT_DOWN");
    }
    throw err;
  }
}

export function extractFront(note: AnkiNoteInfo): string {
  const raw =
    note.fields?.Front?.value ||
    note.fields?.Text?.value ||
    note.fields?.Question?.value ||
    "";
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\{\{c\d+::([^}:]*?)(?:::[^}]*)?\}\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export async function findNotes(query: string): Promise<number[]> {
  return ankiConnect<number[]>("findNotes", { query });
}

export async function notesInfo(notes: number[]): Promise<AnkiNoteInfo[]> {
  return ankiConnect<AnkiNoteInfo[]>("notesInfo", { notes });
}

export async function findCards(query: string): Promise<number[]> {
  return ankiConnect<number[]>("findCards", { query });
}

export async function cardsInfo(cards: number[]): Promise<AnkiCardInfo[]> {
  return ankiConnect<AnkiCardInfo[]>("cardsInfo", { cards });
}

export async function addTags(notes: number[], tags: string): Promise<void> {
  await ankiConnect("addTags", { notes, tags });
}

export async function removeTags(notes: number[], tags: string): Promise<void> {
  await ankiConnect("removeTags", { notes, tags });
}

export async function guiBrowse(query: string): Promise<void> {
  await ankiConnect("guiBrowse", { query });
}

export async function getDueStatus(
  noteIds: number[]
): Promise<Map<number, "due" | "new">> {
  if (!noteIds.length) return new Map();

  const nidQuery = noteIds.map((id) => `nid:${id}`).join(" OR ");
  const [dueResult, newResult] = await Promise.allSettled([
    findCards(`(${nidQuery}) is:due`),
    findCards(`(${nidQuery}) is:new`),
  ]);
  const dueCardIds = dueResult.status === "fulfilled" ? dueResult.value : [];
  const newCardIds = newResult.status === "fulfilled" ? newResult.value : [];

  const status = new Map<number, "due" | "new">();
  const allCardIds = [...new Set([...dueCardIds, ...newCardIds])];

  if (allCardIds.length) {
    const infos = await cardsInfo(allCardIds);
    const dueCardSet = new Set(dueCardIds);
    for (const info of infos) {
      const nid = info.note;
      if (dueCardSet.has(info.cardId)) {
        status.set(nid, "due");
      } else if (!status.has(nid)) {
        status.set(nid, "new");
      }
    }
  }
  return status;
}
