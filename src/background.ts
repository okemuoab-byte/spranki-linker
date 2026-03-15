// ============================================================
// Spranki Linker — Background Service Worker
// ============================================================

import {
  DECK_NAME,
  CACHE_TTL,
  COMMUNITY_SYNC_ALARM,
  COMMUNITY_SYNC_INTERVAL_HOURS,
} from "./constants";
import {
  ankiConnect,
  extractFront,
  findNotes,
  notesInfo,
  getDueStatus,
  guiBrowse,
  addTags,
  removeTags,
} from "./utils/anki";
import { fuzzyScore } from "./utils/fuzzy";
import {
  getMappings,
  saveMapping,
  removeFromMapping,
  invalidateMappingsCache,
} from "./utils/mappings";
import {
  uploadMapping,
  fetchMappingForQID,
  fetchTopMappings,
} from "./utils/supabase";
import type {
  AnkiCard,
  AnkiNoteInfo,
  Mapping,
  Platform,
  ScoredCard,
  SessionHistoryEntry,
  SessionReviewCard,
  SessionReviewGroup,
} from "./types";

// ── Spranki card cache ────────────────────────────────────────
interface SprankiCard {
  noteId: number;
  front: string;
  tags: string[];
}

let sprankiCardCache: SprankiCard[] | null = null;
let sprankiCacheTime = 0;

async function getSprankiCards(): Promise<SprankiCard[]> {
  if (sprankiCardCache && Date.now() - sprankiCacheTime < CACHE_TTL) {
    return sprankiCardCache;
  }

  const noteIds = await findNotes(`deck:"${DECK_NAME}"`);
  if (!noteIds.length) return [];

  const cards: SprankiCard[] = [];
  for (let i = 0; i < noteIds.length; i += 100) {
    const notes = await notesInfo(noteIds.slice(i, i + 100));
    for (const note of notes) {
      const front = extractFront(note);
      if (front) cards.push({ noteId: note.noteId, front, tags: note.tags || [] });
    }
  }

  sprankiCardCache = cards;
  sprankiCacheTime = Date.now();
  return cards;
}

// ── Claude-powered title → tag lookup ────────────────────────
async function claudeTagSearch(title: string, apiKey: string): Promise<string | null> {
  const cards = await getSprankiCards();
  const tagPaths = [
    ...new Set(
      cards.flatMap((c) =>
        c.tags
          .filter((t) => t.includes("::"))
          .map((t) => t.split("::").slice(1).join("::"))
      )
    ),
  ]
    .sort()
    .slice(0, 300)
    .join("\n");

  const requestBody = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 80,
    messages: [
      {
        role: "user",
        content:
          `Anki tag paths in this deck (Category::SubCategory format):\n${tagPaths}\n\n` +
          `PassMed topic: "${title}"\n\n` +
          `Find the best matching tag path above. ` +
          `Return an Anki search using BOTH the category and subcategory as separate tag wildcards for specificity. ` +
          `Format: tag:*Category* tag:*SubCategory*\n` +
          `If only one level exists, use: tag:*Word*\n` +
          `Reply with only the search string, nothing else.`,
      },
    ],
  });

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: requestBody,
  });

  if (!res.ok) {
    if (res.status === 429) {
      const wait = parseInt(res.headers.get("retry-after") ?? "5", 10) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      const retry = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: requestBody,
      });
      if (!retry.ok) throw new Error(`Claude API ${retry.status}`);
      const retryData = (await retry.json()) as { content: Array<{ text: string }> };
      const retrySearch = retryData.content[0].text.trim();
      return retrySearch.startsWith("tag:") ? retrySearch : null;
    }
    throw new Error(`Claude API ${res.status}`);
  }

  const data = (await res.json()) as { content: Array<{ text: string }> };
  const search = data.content[0].text.trim();
  return search.startsWith("tag:") ? search : null;
}

// ── Suggestion pipeline ───────────────────────────────────────
async function getSuggestions(
  questionText: string,
  title = ""
): Promise<ScoredCard[]> {
  if (title) {
    const stored = await chrome.storage.local.get(["claudeApiKey", "titleCache"]);
    const titleCache = (stored.titleCache as Record<string, string>) || {};

    let search: string | undefined | null = titleCache[title];

    if (!search && stored.claudeApiKey) {
      try {
        search = await claudeTagSearch(title, stored.claudeApiKey as string);
        if (search) {
          titleCache[title] = search;
          await chrome.storage.local.set({ titleCache });
        }
      } catch (e) {
        console.warn("Claude tag lookup failed:", (e as Error).message);
      }
    }

    if (search) {
      try {
        const noteIds = await findNotes(`deck:"${DECK_NAME}" ${search}`);
        if (noteIds.length > 0) {
          const notes = await notesInfo(noteIds.slice(0, 20));
          const scored = notes
            .map((n) => ({
              noteId: n.noteId,
              front: extractFront(n),
              tags: n.tags || [],
              score: fuzzyScore(questionText, extractFront(n), n.tags || [], title),
            }))
            .filter((n) => n.front)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
          if (scored.length > 0 && scored[0].score === 0) {
            scored.forEach((c) => {
              c.score = 0.4;
            });
          }
          return scored;
        }
        return [];
      } catch (e) {
        console.warn("Anki search failed:", (e as Error).message);
        return [];
      }
    }
  }

  // Fuzzy fallback (no API key)
  const cards = await getSprankiCards();
  return cards
    .map((c) => ({ ...c, score: fuzzyScore(questionText, c.front, c.tags, title) }))
    .filter((c) => c.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ── Community sync ────────────────────────────────────────────
async function syncCommunityMappings(): Promise<number> {
  const rows = await fetchTopMappings();
  if (!rows.length) return 0;

  // Fold rows into MappingStore shape: platform → qid → { noteIds }
  const community: Record<string, Record<string, { noteIds: number[]; topic?: string }>> = {};
  for (const row of rows) {
    if (!community[row.platform]) community[row.platform] = {};
    const entry = community[row.platform][row.qid];
    if (entry) {
      if (!entry.noteIds.includes(row.note_id)) entry.noteIds.push(row.note_id);
    } else {
      community[row.platform][row.qid] = {
        noteIds: [row.note_id],
        topic: row.topic ?? undefined,
      };
    }
  }

  await chrome.storage.local.set({ communityMappings: community });
  invalidateMappingsCache();
  return rows.length;
}

// ── Core mapping lookup ───────────────────────────────────────
async function lookupCards(
  platform: Platform,
  qid: string
): Promise<{ cards: AnkiCard[]; error?: string }> {
  const mappings = await getMappings();
  const platformMappings = (mappings as unknown as Record<string, Record<string, Mapping>>)[platform] || {};
  let mapping = platformMappings[qid] as Mapping | undefined;

  // Community live fallback — check Supabase for QIDs not in the last sync batch
  if (!mapping) {
    const communityNoteIds = await fetchMappingForQID(platform, qid);
    if (communityNoteIds.length) {
      mapping = { noteIds: communityNoteIds };
    }
  }

  if (!mapping) return { error: "No mapping found", cards: [] };

  let noteIds: number[] = [];

  if (mapping.noteIds?.length) {
    noteIds = mapping.noteIds;
  } else if (mapping.tags?.length) {
    const query = mapping.tags.map((t) => `tag:${t}`).join(" OR ");
    noteIds = await findNotes(query);
  } else if (mapping.search) {
    noteIds = await findNotes(`deck:"${DECK_NAME}" ${mapping.search}`);
  }

  if (noteIds.length === 0) return { cards: [] };

  const [notes, dueStatus] = await Promise.all([
    notesInfo(noteIds),
    getDueStatus(noteIds),
  ]);

  const cards: AnkiCard[] = notes.map((n) => ({
    noteId: n.noteId,
    front: extractFront(n),
    tags: n.tags || [],
    dueStatus: dueStatus.get(n.noteId) ?? null,
  }));

  return { cards };
}

// ── Session review lookup ─────────────────────────────────────
async function getSessionReview(
  platform: Platform
): Promise<{ wrongCount: number; groups: SessionReviewGroup[]; allNoteIds: number[] }> {
  const stored = await chrome.storage.local.get("sessionWrong");
  const wrongMap = ((stored.sessionWrong || {}) as Record<string, Record<string, string>>)[platform] || {};
  const wrongQIDs = Object.keys(wrongMap);

  if (!wrongQIDs.length) return { wrongCount: 0, groups: [], allNoteIds: [] };

  const mappings = await getMappings();
  const platformMappings = (mappings as unknown as Record<string, Record<string, Mapping>>)[platform] || {};
  const allNoteIds: number[] = [];
  const groups: SessionReviewGroup[] = [];

  for (const qid of wrongQIDs) {
    const title = wrongMap[qid];
    const mapping = platformMappings[qid] as Mapping | undefined;
    let noteIds: number[] = [];

    if (mapping?.noteIds?.length) {
      noteIds = mapping.noteIds;
    } else if (mapping?.tags?.length) {
      try {
        const query = mapping.tags.map((t) => `tag:${t}`).join(" OR ");
        noteIds = await findNotes(query);
      } catch {
        /* skip */
      }
    } else if (mapping?.search) {
      try {
        noteIds = await findNotes(`deck:"${DECK_NAME}" ${mapping.search}`);
      } catch {
        /* skip */
      }
    }

    let cards: SessionReviewCard[] = [];
    if (noteIds.length) {
      try {
        const notes = await notesInfo(noteIds);
        cards = notes
          .map((n) => ({
            noteId: n.noteId,
            front: extractFront(n),
            tags: n.tags || [],
          }))
          .filter((c) => c.front);
        allNoteIds.push(...noteIds);
      } catch {
        /* ankiConnectDown handled below */
      }
    }

    groups.push({ qid, title, cards });
  }

  return {
    wrongCount: wrongQIDs.length,
    groups,
    allNoteIds: [...new Set(allNoteIds)],
  };
}

// ── Message handler ───────────────────────────────────────────
chrome.runtime.onMessage.addListener(
  (
    message: { type: string; [key: string]: unknown },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    if (message.type === "LOOKUP_CARDS") {
      lookupCards(message.platform as Platform, message.qid as string)
        .then((result) => sendResponse(result))
        .catch((err: Error) => {
          if (err.message === "ANKICONNECT_DOWN") {
            sendResponse({ ankiConnectDown: true, cards: [] });
          } else {
            sendResponse({ error: err.message, cards: [] });
          }
        });
      return true;
    }

    if (message.type === "GET_SUGGESTIONS") {
      getSuggestions(message.questionText as string, (message.title as string) || "")
        .then((suggestions) => sendResponse({ suggestions }))
        .catch((err: Error) => {
          if (err.message === "ANKICONNECT_DOWN") {
            sendResponse({ ankiConnectDown: true, suggestions: [] });
          } else {
            sendResponse({ error: err.message, suggestions: [] });
          }
        });
      return true;
    }

    if (message.type === "SAVE_MAPPING") {
      const platform = message.platform as Platform;
      const qid = message.qid as string;
      const noteId = message.noteId as number;
      const topic = message.topic as string | undefined;
      saveMapping(platform, qid, noteId, topic)
        .then(() => {
          // Fire-and-forget community upload — never block the response
          void uploadMapping(platform, qid, noteId, topic);
          sendResponse({ ok: true });
        })
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === "SYNC_COMMUNITY_MAPPINGS") {
      syncCommunityMappings()
        .then((synced) => sendResponse({ synced }))
        .catch(() => sendResponse({ synced: 0 }));
      return true;
    }

    if (message.type === "REMOVE_FROM_MAPPING") {
      removeFromMapping(
        message.platform as Platform,
        message.qid as string,
        message.noteId as number
      )
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === "OPEN_IN_ANKI") {
      guiBrowse(`nid:${message.noteId as number}`).catch(console.error);
      return false;
    }

    if (message.type === "TAG_CARD") {
      addTags([Number(message.noteId)], message.tag as string).catch(console.error);
      return false;
    }

    if (message.type === "GET_PASSMED_QID") {
      chrome.scripting
        .executeScript({
          target: { tabId: sender.tab!.id! },
          world: "MAIN",
          func: () => {
            const d = (window as unknown as { question_data?: Record<string, unknown> })
              .question_data;
            if (!d) return { qid: null };
            const nid = d.new_question_id;

            let answeredCorrectly: boolean | null = null;
            const correctAns = String(d.correct_answer ?? d.answer ?? "");

            if (typeof d.answered_correctly === "boolean") {
              answeredCorrectly = d.answered_correctly;
            } else if (typeof d.is_correct === "boolean") {
              answeredCorrectly = d.is_correct;
            } else {
              const w = window as unknown as Record<string, unknown>;
              const userAns = String(
                d.selected_answer ?? d.user_answer ?? d.selected ??
                  w.selected_answer ?? w.user_answer ?? ""
              );
              if (userAns && correctAns) {
                answeredCorrectly = userAns === correctAns;
              }
            }

            return {
              qid: nid && String(nid) !== "0" ? String(nid) : null,
              title: (d.title as string) || null,
              question:
                (Array.isArray(d.questions) && d.questions[0]) || d.question || null,
              answeredCorrectly,
            };
          },
        })
        .then((results) => {
          sendResponse(results?.[0]?.result ?? { qid: null });
        })
        .catch(() => sendResponse({ qid: null }));
      return true;
    }

    if (message.type === "TEST_ANKICONNECT") {
      ankiConnect<number>("version")
        .then((v) => sendResponse({ ok: true, version: v }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === "SAVE_API_KEY") {
      chrome.storage.local
        .set({ claudeApiKey: message.apiKey })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === "GET_CACHE_STATS") {
      chrome.storage.local.get(["titleCache", "claudeApiKey"]).then((stored) => {
        sendResponse({
          hasKey: !!stored.claudeApiKey,
          cached: Object.keys((stored.titleCache as Record<string, unknown>) || {}).length,
        });
      });
      return true;
    }

    if (message.type === "RELOAD_MAPPINGS") {
      invalidateMappingsCache();
      sprankiCardCache = null;
      getMappings()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === "RECORD_WRONG") {
      chrome.storage.local
        .get("sessionWrong")
        .then((stored) => {
          const session = (stored.sessionWrong as Record<string, Record<string, string>>) || {};
          const key = message.platform as string;
          if (!session[key]) session[key] = {};
          if (!(message.qid as string in session[key])) {
            session[key][message.qid as string] = (message.title as string) || "";
          }
          return chrome.storage.local
            .set({ sessionWrong: session })
            .then(() => Object.keys(session[key]).length);
        })
        .then((count) => sendResponse({ ok: true, count }))
        .catch(() => sendResponse({ ok: false, count: 0 }));
      return true;
    }

    if (message.type === "GET_SESSION_REVIEW") {
      getSessionReview(message.platform as Platform)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ wrongCount: 0, groups: [], allNoteIds: [] }));
      return true;
    }

    if (message.type === "OPEN_SESSION_IN_ANKI") {
      const noteIds = message.noteIds as number[];
      const query = noteIds.map((id) => `nid:${id}`).join(" OR ");
      guiBrowse(query).catch(console.error);
      return false;
    }

    if (message.type === "STUDY_SESSION_IN_ANKI") {
      const noteIds = message.noteIds as number[];
      if (!noteIds?.length) {
        sendResponse({ ok: false });
        return true;
      }
      addTags(noteIds, "sprankiLinker::review")
        .then(() => guiBrowse("tag:sprankiLinker::review"))
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message.type === "CLEAR_REVIEW_TAG") {
      findNotes("tag:sprankiLinker::review")
        .then((noteIds) => {
          if (!noteIds.length) return sendResponse({ ok: true, cleared: 0 });
          return removeTags(noteIds, "sprankiLinker::review").then(() =>
            sendResponse({ ok: true, cleared: noteIds.length })
          );
        })
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message.type === "CLEAR_SESSION") {
      chrome.storage.local
        .get(["sessionWrong", "sessionHistory"])
        .then((stored) => {
          const platform = message.platform as string;
          const wrongMap =
            ((stored.sessionWrong as Record<string, Record<string, string>>) || {})[
              platform
            ] || {};
          const wrongQIDs = Object.keys(wrongMap);
          const history = (stored.sessionHistory as SessionHistoryEntry[]) || [];

          if (wrongQIDs.length > 0) {
            const entry: SessionHistoryEntry = {
              date: new Date().toISOString().slice(0, 10),
              platform,
              wrongCount: wrongQIDs.length,
              questions: wrongQIDs.map((qid) => ({
                qid,
                title: wrongMap[qid] || "",
              })),
            };
            history.unshift(entry);
            if (history.length > 10) history.length = 10;
          }

          const updatedWrong = (stored.sessionWrong as Record<string, unknown>) || {};
          delete updatedWrong[platform];
          return chrome.storage.local.set({
            sessionHistory: history,
            sessionWrong: updatedWrong,
          });
        })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === "GET_SESSION_HISTORY") {
      chrome.storage.local.get("sessionHistory").then((stored) => {
        const history = ((stored.sessionHistory as SessionHistoryEntry[]) || []).filter(
          (e) => e.platform === message.platform
        );
        sendResponse({ history });
      });
      return true;
    }

    return false;
  }
);

// ── Startup & periodic community sync ────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  void syncCommunityMappings();
  chrome.alarms.create(COMMUNITY_SYNC_ALARM, {
    periodInMinutes: COMMUNITY_SYNC_INTERVAL_HOURS * 60,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COMMUNITY_SYNC_ALARM) {
    void syncCommunityMappings();
  }
});
