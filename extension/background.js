// ============================================================
// Spranki Linker - Background Service Worker
// Handles AnkiConnect API calls and mapping file lookups
// ============================================================

const ANKICONNECT_URL = "http://localhost:8765";
const MAPPING_VERSION = "0.1.0";

// ── AnkiConnect helper ───────────────────────────────────────
async function ankiConnect(action, params = {}) {
  try {
    const res = await fetch(ANKICONNECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, params })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.result;
  } catch (err) {
    if (err.message?.includes("Failed to fetch") || err.message?.includes("NetworkError")) {
      throw new Error("ANKICONNECT_DOWN");
    }
    throw err;
  }
}

// ── Load mapping file ────────────────────────────────────────
let cachedMappings = null;

async function getMappings() {
  if (cachedMappings) return cachedMappings;

  // Always load bundled mappings as the base
  const url = chrome.runtime.getURL("mappings.json");
  const res = await fetch(url);
  const bundled = await res.json();

  // Deep-merge custom mappings on top (user entries win per-QID)
  const stored = await chrome.storage.local.get("customMappings");
  if (stored.customMappings) {
    const custom = stored.customMappings;
    for (const platform of ["passMed", "quesmed"]) {
      if (custom[platform]) {
        bundled[platform] = { ...(bundled[platform] || {}), ...custom[platform] };
      }
    }
  }

  cachedMappings = bundled;
  return cachedMappings;
}

// ── Due status helper ─────────────────────────────────────────
// Returns a Map of noteId → 'due' | 'new' | null using Anki's own search logic.
// Two batched findCards calls — no epoch arithmetic needed.
async function getDueStatus(noteIds) {
  if (!noteIds.length) return new Map();
  const nidQuery = noteIds.map(id => `nid:${id}`).join(" OR ");
  const [dueCardIds, newCardIds] = await Promise.all([
    ankiConnect("findCards", { query: `(${nidQuery}) is:due` }),
    ankiConnect("findCards", { query: `(${nidQuery}) is:new` }),
  ]);

  const status = new Map();

  // Map card IDs back to note IDs via cardsInfo
  const allCardIds = [...new Set([...dueCardIds, ...newCardIds])];
  if (allCardIds.length) {
    const infos = await ankiConnect("cardsInfo", { cards: allCardIds });
    const dueCardSet = new Set(dueCardIds);
    for (const info of infos) {
      const nid = info.note;
      // 'due' takes priority over 'new' if somehow both
      if (dueCardSet.has(info.cardId)) {
        status.set(nid, "due");
      } else if (!status.has(nid)) {
        status.set(nid, "new");
      }
    }
  }
  return status;
}

// ── Core lookup logic ────────────────────────────────────────
async function lookupCards(platform, qid) {
  const mappings = await getMappings();
  const platformMappings = mappings[platform] || {};
  const mapping = platformMappings[qid];

  if (!mapping) return { error: "No mapping found", cards: [] };

  let noteIds = [];

  if (mapping.noteIds?.length) {
    noteIds = mapping.noteIds;
  } else if (mapping.tags?.length) {
    const query = mapping.tags.map(t => `tag:${t}`).join(" OR ");
    noteIds = await ankiConnect("findNotes", { query });
  } else if (mapping.search) {
    noteIds = await ankiConnect("findNotes", { query: `deck:"!Spranki Clinical" ${mapping.search}` });
  }

  if (noteIds.length === 0) return { cards: [] };

  const [notesInfo, dueStatus] = await Promise.all([
    ankiConnect("notesInfo", { notes: noteIds }),
    getDueStatus(noteIds),
  ]);

  const cards = notesInfo.map(n => ({
    noteId: n.noteId,
    front: extractFront(n),
    tags: n.tags || [],
    dueStatus: dueStatus.get(n.noteId) || null,
  }));
  return { cards };
}

// ── Spranki card cache (for suggestions) ─────────────────────
let sprankiCardCache = null;
let sprankiCacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function extractFront(note) {
  const raw = note.fields?.Front?.value
           || note.fields?.Text?.value
           || note.fields?.Question?.value
           || "";
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

async function getSprankiCards() {
  if (sprankiCardCache && Date.now() - sprankiCacheTime < CACHE_TTL) {
    return sprankiCardCache;
  }

  const noteIds = await ankiConnect("findNotes", { query: 'deck:"!Spranki Clinical"' });
  if (!noteIds.length) return [];

  const cards = [];
  for (let i = 0; i < noteIds.length; i += 100) {
    const notes = await ankiConnect("notesInfo", { notes: noteIds.slice(i, i + 100) });
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
async function claudeTagSearch(title, apiKey) {
  // Send full tag paths (not just leaf segments) so Claude can see hierarchy.
  // e.g. "Paediatrics::NeonatalScreening" vs "Gynaecology::CervicalScreening"
  // This lets Claude pick specific leaf tags rather than broad shared words.
  const cards = await getSprankiCards();
  const tagPaths = [...new Set(
    cards.flatMap(c =>
      c.tags
        .filter(t => t.includes("::"))
        .map(t => t.split("::").slice(1).join("::"))  // strip deck prefix
    )
  )].sort().slice(0, 300).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      messages: [{
        role: "user",
        content:
          `Anki tag paths in this deck (Category::SubCategory format):\n${tagPaths}\n\n` +
          `PassMed topic: "${title}"\n\n` +
          `Find the best matching tag path above. ` +
          `Return an Anki search using BOTH the category and subcategory as separate tag wildcards for specificity. ` +
          `Format: tag:*Category* tag:*SubCategory*\n` +
          `If only one level exists, use: tag:*Word*\n` +
          `Reply with only the search string, nothing else.`
      }]
    })
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const search = data.content[0].text.trim();
  return search.startsWith("tag:") ? search : null;
}

// ── Fuzzy scoring ────────────────────────────────────────────
// Tags (e.g. "!Spranki Clinical::Cardiology::HeartFailure") carry
// more signal than card text for medical content — weighted 60/40.
function fuzzyScore(questionText, cardFront, cardTags = [], title = "") {
  const tokenize = s =>
    s.toLowerCase()
     .replace(/['']/g, "")
     .split(/\W+/)
     .filter(w => w.length > 3);

  const qSet = new Set(tokenize(questionText));
  const titleSet = new Set(tokenize(title));
  if (!qSet.size && !titleSet.size) return 0;

  // CamelCase-split tag words: "HeartFailure" → ["heart", "failure"]
  const tagWords = new Set(
    cardTags.flatMap(tag =>
      tag.split("::").slice(1).flatMap(segment =>
        tokenize(segment.replace(/([a-z])([A-Z])/g, "$1 $2"))
      )
    )
  );

  // Title → tag overlap (title is the precise topic signal from PassMed)
  let titleTagOverlap = 0;
  for (const t of titleSet) if (tagWords.has(t)) titleTagOverlap++;
  const titleTagScore = titleSet.size > 0 ? titleTagOverlap / titleSet.size : 0;

  // Question text → tag overlap
  let qTagOverlap = 0;
  for (const t of qSet) if (tagWords.has(t)) qTagOverlap++;
  const qTagScore = qSet.size > 0 ? qTagOverlap / qSet.size : 0;

  // Question text → card front overlap
  const cSet = new Set(tokenize(cardFront));
  let textOverlap = 0;
  for (const t of qSet) if (cSet.has(t)) textOverlap++;
  const textScore = qSet.size > 0
    ? textOverlap / Math.sqrt(qSet.size * Math.max(cSet.size, 1))
    : 0;

  // Title is the best signal (50%), question-tag secondary (30%), text tertiary (20%)
  return (titleTagScore * 0.5) + (qTagScore * 0.3) + (textScore * 0.2);
}

async function getSuggestions(questionText, title = "") {
  // ── Path 1: Claude-powered title lookup (most accurate) ──────
  if (title) {
    const stored = await chrome.storage.local.get(["claudeApiKey", "titleCache"]);
    const titleCache = stored.titleCache || {};

    // Check local cache first — no API call needed if title was seen before
    let search = titleCache[title];

    // If not cached and API key is set, ask Claude
    if (!search && stored.claudeApiKey) {
      try {
        search = await claudeTagSearch(title, stored.claudeApiKey);
        if (search) {
          titleCache[title] = search;
          await chrome.storage.local.set({ titleCache });
        }
      } catch (e) {
        console.warn("Claude tag lookup failed:", e.message);
      }
    }

    // Run the Anki search if we have one
    if (search) {
      try {
        const noteIds = await ankiConnect("findNotes", {
          query: `deck:"!Spranki Clinical" ${search}`
        });
        if (noteIds.length > 0) {
          // Fuzzy-rank within Claude's candidate pool for differentiated scores.
          const notes = await ankiConnect("notesInfo", { notes: noteIds.slice(0, 20) });
          const scored = notes
            .map(n => ({
              noteId: n.noteId,
              front: extractFront(n),
              tags: n.tags || [],
              score: fuzzyScore(questionText, extractFront(n), n.tags || [], title)
            }))
            .filter(n => n.front)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
          if (scored.length > 0 && scored[0].score === 0) {
            scored.forEach(c => { c.score = 0.40; });
          }
          return scored;
        }
        // Claude's search found 0 cards — this topic likely has no card in the deck.
        // Return empty rather than falling through to full-deck fuzzy, which would
        // surface superficially similar cards (e.g. "screening" matching cervical cards).
        return [];
      } catch (e) {
        console.warn("Anki search failed:", e.message);
      }
    }
  }

  // ── Path 2: Fuzzy fallback (no API key set) ──────────────────
  // Only reached when Claude is not configured. Higher threshold avoids
  // low-confidence matches that share a word but not the topic.
  const cards = await getSprankiCards();
  return cards
    .map(c => ({ ...c, score: fuzzyScore(questionText, c.front, c.tags, title) }))
    .filter(c => c.score > 0.20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ── Save a user-confirmed mapping ────────────────────────────
async function saveMapping(platform, qid, noteId, topic) {
  const stored = await chrome.storage.local.get("customMappings");
  const maps = stored.customMappings || { passMed: {}, quesmed: {} };
  if (!maps[platform]) maps[platform] = {};
  const existing = maps[platform][String(qid)];
  if (existing) {
    // Append to existing mapping — allow multiple cards per question
    const ids = new Set(existing.noteIds || []);
    ids.add(noteId);
    existing.noteIds = [...ids];
    existing.search = null; // noteIds take priority over search in lookupCards
  } else {
    maps[platform][String(qid)] = {
      noteIds: [noteId],
      topic,
      contributor: "self",
      autoMapped: true,
    };
  }
  await chrome.storage.local.set({ customMappings: maps });
  cachedMappings = null;
}

// ── Message handler ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "LOOKUP_CARDS") {
    lookupCards(message.platform, message.qid)
      .then(result => sendResponse(result))
      .catch(err => {
        if (err.message === "ANKICONNECT_DOWN") {
          sendResponse({ ankiConnectDown: true, cards: [] });
        } else {
          sendResponse({ error: err.message, cards: [] });
        }
      });
    return true;
  }

  if (message.type === "GET_SUGGESTIONS") {
    getSuggestions(message.questionText, message.title || "")
      .then(suggestions => sendResponse({ suggestions }))
      .catch(err => {
        if (err.message === "ANKICONNECT_DOWN") {
          sendResponse({ ankiConnectDown: true, suggestions: [] });
        } else {
          sendResponse({ error: err.message, suggestions: [] });
        }
      });
    return true;
  }

  if (message.type === "SAVE_MAPPING") {
    saveMapping(message.platform, message.qid, message.noteId, message.topic)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "OPEN_IN_ANKI") {
    ankiConnect("guiBrowse", { query: `nid:${message.noteId}` })
      .catch(console.error);
    return false;
  }

  if (message.type === "TAG_CARD") {
    ankiConnect("addTags", {
      notes: [Number(message.noteId)],
      tags: message.tag
    }).catch(console.error);
    return false;
  }

  if (message.type === "GET_PASSMED_QID") {
    // Reads window.question_data directly from the page's JS context.
    // Returns qid, title (PassMed topic name), and decoded question text.
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: () => {
        const d = window.question_data;
        if (!d) return { qid: null };
        const nid = d.new_question_id;

        // Try to detect if the user answered and whether they got it right.
        // Only use definitive signals — no DOM wildcards that fire on unanswered questions.
        let answeredCorrectly = null;
        const correctAns = String(d.correct_answer || d.answer || "");

        // 1. Check question_data itself for an answered state field
        if (typeof d.answered_correctly === "boolean") {
          answeredCorrectly = d.answered_correctly;
        } else if (typeof d.is_correct === "boolean") {
          answeredCorrectly = d.is_correct;
        } else {
          // 2. Compare user's answer to correct answer via known window or question_data fields
          const userAns = String(
            d.selected_answer ?? d.user_answer ?? d.selected ??
            window.selected_answer ?? window.user_answer ?? ""
          );
          if (userAns && correctAns) {
            answeredCorrectly = userAns === correctAns;
          }
        }

        return {
          qid: nid && String(nid) !== "0" ? String(nid) : null,
          title: d.title || null,
          question: (Array.isArray(d.questions) && d.questions[0]) || d.question || null,
          answeredCorrectly,
        };
      }
    }).then(results => {
      sendResponse(results?.[0]?.result ?? { qid: null });
    }).catch(() => sendResponse({ qid: null }));
    return true;
  }

  if (message.type === "TEST_ANKICONNECT") {
    ankiConnect("version")
      .then(v => sendResponse({ ok: true, version: v }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "REMOVE_FROM_MAPPING") {
    chrome.storage.local.get("customMappings").then(stored => {
      const maps = stored.customMappings || { passMed: {}, quesmed: {} };
      const entry = (maps[message.platform] || {})[String(message.qid)];
      if (entry) {
        entry.noteIds = (entry.noteIds || []).filter(id => id !== message.noteId);
        // If no noteIds left and no search, remove the entry entirely
        if (!entry.noteIds.length && !entry.search) {
          delete maps[message.platform][String(message.qid)];
        }
      }
      return chrome.storage.local.set({ customMappings: maps });
    }).then(() => {
      cachedMappings = null;
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "SAVE_API_KEY") {
    chrome.storage.local.set({ claudeApiKey: message.apiKey })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "GET_CACHE_STATS") {
    chrome.storage.local.get(["titleCache", "claudeApiKey"]).then(stored => {
      sendResponse({
        hasKey: !!stored.claudeApiKey,
        cached: Object.keys(stored.titleCache || {}).length
      });
    });
    return true;
  }

  if (message.type === "RELOAD_MAPPINGS") {
    cachedMappings = null;
    sprankiCardCache = null; // also clear suggestion cache
    getMappings()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "RECORD_WRONG") {
    // sessionWrong format: { platform: { qid: title } }
    chrome.storage.local.get("sessionWrong").then(stored => {
      const session = stored.sessionWrong || {};
      const key = message.platform;
      if (!session[key]) session[key] = {};
      if (!(message.qid in session[key])) {
        session[key][message.qid] = message.title || "";
      }
      return chrome.storage.local.set({ sessionWrong: session })
        .then(() => Object.keys(session[key]).length);
    }).then(count => sendResponse({ ok: true, count }))
      .catch(() => sendResponse({ ok: false, count: 0 }));
    return true;
  }

  if (message.type === "GET_SESSION_REVIEW") {
    chrome.storage.local.get("sessionWrong").then(async stored => {
      const platform = message.platform;
      const wrongMap = (stored.sessionWrong || {})[platform] || {};
      const wrongQIDs = Object.keys(wrongMap);

      if (!wrongQIDs.length) {
        sendResponse({ wrongCount: 0, groups: [], allNoteIds: [] });
        return;
      }

      const mappings = await getMappings();
      const platformMappings = mappings[platform] || {};
      const allNoteIds = [];
      const groups = [];

      for (const qid of wrongQIDs) {
        const title = wrongMap[qid];
        const mapping = platformMappings[qid];
        let noteIds = [];

        if (mapping?.noteIds?.length) {
          noteIds = mapping.noteIds;
        } else if (mapping?.search) {
          try {
            noteIds = await ankiConnect("findNotes", {
              query: `deck:"!Spranki Clinical" ${mapping.search}`
            });
          } catch (e) { /* skip */ }
        }

        let cards = [];
        if (noteIds.length) {
          try {
            const notes = await ankiConnect("notesInfo", { notes: noteIds });
            cards = notes.map(n => ({
              noteId: n.noteId,
              front: extractFront(n),
              tags: n.tags || [],
            })).filter(c => c.front);
            allNoteIds.push(...noteIds);
          } catch (e) { /* ankiConnectDown handled below */ }
        }

        groups.push({ qid, title, cards });
      }

      sendResponse({
        wrongCount: wrongQIDs.length,
        groups,
        allNoteIds: [...new Set(allNoteIds)],
      });
    }).catch(() => sendResponse({ wrongCount: 0, groups: [], allNoteIds: [] }));
    return true;
  }

  if (message.type === "OPEN_SESSION_IN_ANKI") {
    // Open Anki browser with all session wrong cards
    const query = message.noteIds.map(id => `nid:${id}`).join(" OR ");
    ankiConnect("guiBrowse", { query }).catch(console.error);
    return false;
  }

  if (message.type === "CLEAR_SESSION") {
    chrome.storage.local.remove("sessionWrong")
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
