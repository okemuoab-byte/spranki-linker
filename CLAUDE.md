# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Spranki Linker** is a Chrome Extension (Manifest V3) that links PassMed and Quesmed medical question bank questions to matching cards in the user's **Spranki Anki deck** via the AnkiConnect local API.

The extension shows a floating overlay on question pages with the linked Anki cards. If no mapping exists yet, it auto-suggests cards from the user's deck using Claude AI (title→tag search) or fuzzy scoring, and saves confirmed links to `chrome.storage.local`.

## Architecture

```
extension/          ← Load this folder as unpacked extension in Chrome
  manifest.json     ← MV3: permissions, host_permissions, content_scripts, service_worker
  background.js     ← Service worker: AnkiConnect calls, mapping lookup, fuzzy/Claude scoring
  content.js        ← Injected into PassMed/Quesmed: QID extraction, overlay rendering
  mappings.json     ← Bundled QID→noteId/tag/search mappings (base; user entries override)
  popup.html/js     ← Extension popup: status, Claude API key, export/import mappings
  styles/
    overlay.css     ← Overlay UI styles (dark navy theme, Lucide icons, CSS animations)
  icons/            ← icon16/48/128.png

mapping-tools/
  mapping_builder.py  ← Offline tool: fetches Spranki cards from Anki, fuzzy-matches CSV export
```

## Key Technical Details

### Supported Platforms
- `https://www.passmedicine.com/*` — QID from `window.question_data.new_question_id` (polled via `chrome.scripting.executeScript` in MAIN world every 1s). URL `?q=` param only works for direct links; quiz mode uses `?q=0`.
- `https://quesmed.com/*` — QID from `/question/123` URL path or `[data-id]` DOM element.

### AnkiConnect
Local HTTP API at `http://localhost:8765`. Actions used: `findNotes`, `notesInfo`, `cardsInfo`, `findCards`, `addTags`, `guiBrowse`, `version`.

### Anki Deck
`!Spranki Clinical` (exact, case-sensitive, always quoted in queries).

### Mapping Resolution (`lookupCards` in background.js)
1. `noteIds` array → direct note lookup
2. `tags` array → `findNotes` with `tag:X OR tag:Y`
3. `search` string → `findNotes` with `deck:"!Spranki Clinical" <search>`

### Mapping Storage
`mappings.json` is the bundled base (currently empty — no community mappings). User-confirmed links go to `chrome.storage.local` under `customMappings`. `getMappings()` deep-merges them (custom entries win per-QID). `cachedMappings` is a module-level cache; set `null` to invalidate.

### Suggestion Pipeline (`getSuggestions` in background.js)
**Path 1 — Claude (most accurate, requires API key):**
1. Check `titleCache` in storage — if seen before, reuse cached Anki search string.
2. If not cached: call `claude-haiku-4-5-20251001` with the full deck tag path list + question title. Claude returns an Anki search like `tag:*Cardiology* tag:*HeartFailure*`.
3. Run that search against AnkiConnect. If 0 results → return `[]` (topic likely not in deck). If results → fuzzy-rank within the candidate pool.
4. Rate-limited (429): wait `retry-after` header seconds, retry once.

**Path 2 — Fuzzy fallback (no API key):**
Full-deck fuzzy score. Threshold: `> 0.20`. Returns top 5.

**Fuzzy scoring (`fuzzyScore`):** 50% title→tag + 30% question→tag + 20% text→front. Tags tokenised by CamelCase split + `::` segments. Cloze markers and HTML stripped from card fronts.

### Due Status (`getDueStatus` in background.js)
Two parallel `findCards` calls: `(nids) is:due` and `(nids) is:new`. Results mapped back to note IDs via `cardsInfo`. Returns `Map<noteId, 'due'|'new'|null>`. Attached to each card on `LOOKUP_CARDS`.

### Session Tracking (`chrome.storage.local`)
- `sessionWrong`: `{ platform: { qid: title } }` — questions marked wrong this session per platform.
- `sessionHistory`: array of `{ date, platform, wrongCount, questions: [{qid,title}] }`, max 10, newest first.
- Wrong answers auto-recorded when PassMed `window.question_data` shows `answeredCorrectly === false`.
- Manual "Mark question wrong" button also available.
- `CLEAR_SESSION` archives current session to history, clears only the active platform's entries.

### Anki Tags Written by Extension
- `sprankiReviewed` — card marked as reviewed via "Mark Reviewed" button.
- `sprankiLinker::review` — added to wrong-session cards by "Study in Anki" button; opens Anki browser filtered to this tag.

### Overlay UI (content.js)
- Built with `innerHTML` / `buildOverlayHTML()` — re-rendered on every state change.
- Icons: Lucide SVG paths extracted from `lucide-react v0.462.0`, inlined as SVG strings via `_ico()` helper.
- Drag: position saved in `overlayPosition` module variable, restored on re-render. `AbortController` cleans up stale `document` listeners on each render.
- Collapse: `body.style.display = "flex" | "none"`.

### SPA Navigation
Patched `history.pushState` + `history.replaceState` + `popstate` + `MutationObserver` fallback. On navigate: `currentQID = null` → `checkAndRenderOverlay`.

## Message Types (content.js → background.js)

| Type | Payload | Response |
|------|---------|----------|
| `LOOKUP_CARDS` | `{platform, qid}` | `{cards, error?, ankiConnectDown?}` |
| `GET_SUGGESTIONS` | `{questionText, title}` | `{suggestions, ankiConnectDown?}` |
| `SAVE_MAPPING` | `{platform, qid, noteId, topic}` | `{ok}` |
| `REMOVE_FROM_MAPPING` | `{platform, qid, noteId}` | `{ok}` |
| `OPEN_IN_ANKI` | `{noteId}` | (fire-and-forget) |
| `TAG_CARD` | `{noteId, tag}` | (fire-and-forget) |
| `GET_PASSMED_QID` | — | `{qid, title, question, answeredCorrectly}` |
| `RECORD_WRONG` | `{platform, qid, title}` | `{ok, count}` |
| `GET_SESSION_REVIEW` | `{platform}` | `{wrongCount, groups, allNoteIds}` |
| `OPEN_SESSION_IN_ANKI` | `{noteIds}` | (fire-and-forget) |
| `STUDY_SESSION_IN_ANKI` | `{noteIds}` | `{ok}` |
| `CLEAR_SESSION` | `{platform}` | `{ok}` |
| `GET_SESSION_HISTORY` | `{platform}` | `{history}` |
| `SAVE_API_KEY` | `{apiKey}` | `{ok}` |
| `GET_CACHE_STATS` | — | `{hasKey, cached}` |
| `TEST_ANKICONNECT` | — | `{ok, version?}` |
| `RELOAD_MAPPINGS` | — | `{ok}` |

## Development Workflow

1. Edit files in `extension/`
2. In Chrome: `chrome://extensions` → Developer Mode → Load unpacked → select `extension/`
3. After editing `background.js`: click the refresh icon on the extension card
4. After editing `content.js` or `manifest.json`: reload extension AND refresh the PassMed/Quesmed tab
5. Debug background: click "service worker" link → DevTools console
6. Debug content script: open DevTools on the PassMed/Quesmed tab → Console

## Current State (as of 2026-03-12)

- Fully functional end-to-end on PassMed; Quesmed URL structure unverified
- Auto-suggest: fires automatically on unmapped questions; Claude path (if API key set) searches by title→tag, fuzzy fallback otherwise
- Due/New badges on linked cards (AnkiConnect `is:due` / `is:new`)
- Session wrong tracking with review panel, history (last 10 sessions), and "Study in Anki"
- Popup: AnkiConnect status, Claude API key management, export/import mappings JSON
- Bundled `mappings.json` is empty; users build personal mappings via auto-suggest
- `mapping_builder.py` exists for offline bulk mapping, `--use-claude` flag stubbed
