# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Spranki Linker** is a Chrome Extension (Manifest V3) that links PassMed and Quesmed medical question bank questions to matching cards in the user's **Spranki Anki deck** via the AnkiConnect local API.

The extension shows a floating overlay on question pages with the linked Anki cards. If no mapping exists yet, it auto-suggests cards from the user's deck using Claude AI (title→tag search) or fuzzy scoring, and saves confirmed links to `chrome.storage.local`.

## Architecture

```
src/                ← TypeScript source (Phase A+)
  manifest.json     ← MV3 manifest with TS source paths (vite-plugin-web-extension reads this)
  background.ts     ← Service worker: AnkiConnect calls, mapping lookup, fuzzy/Claude scoring
  content.ts        ← Injected into PassMed/Quesmed: QID extraction, overlay rendering
  popup.ts          ← Popup logic
  popup.html        ← Popup HTML (references popup.ts via <script type="module">)
  types.ts          ← Shared types: AnkiCard, Mapping, Platform, OverlayResponse, etc.
  constants.ts      ← ANKICONNECT_URL, DECK_NAME, CACHE_TTL
  styles/
    overlay.css     ← Overlay UI styles (dark navy theme, Lucide icons, CSS animations)
  utils/
    anki.ts         ← ankiConnect() + action wrappers (findNotes, notesInfo, getDueStatus…)
    fuzzy.ts        ← fuzzyScore(), tokenize()
    mappings.ts     ← getMappings(), saveMapping(), removeFromMapping(), invalidateMappingsCache()
    icons.ts        ← ICONS constant + _ico() helper
    html.ts         ← escapeHTML()
  overlay/
    build.ts        ← buildOverlayHTML() (pure function)
    drag.ts         ← makeDraggable() (stateful: persists overlayPosition across re-renders)

public/             ← Static assets copied as-is to dist/
  mappings.json     ← Bundled QID→noteId/tag/search mappings (empty base; user entries override)
  icons/            ← icon16/48/128.png

dist/               ← Build output (load this in Chrome; gitignored)
  manifest.json     ← Final MV3 manifest with dist paths
  src/
    background.js   ← Built service worker
    content.js      ← Built content script
    popup.html      ← Built popup
    popup.js        ← Built popup script
    styles/
      overlay.css   ← Built overlay CSS
  icons/            ← Copied icons
  mappings.json     ← Copied mappings

extension/          ← Legacy plain-JS extension (still loadable; kept for reference)
  background.js, content.js, popup.js, manifest.json…

mapping-tools/
  mapping_builder.py  ← Offline tool: fetches Spranki cards from Anki, fuzzy-matches CSV export
```

## Build System

```bash
npm install          # Install devDependencies (TypeScript, Vite, vite-plugin-web-extension)
npm run build        # Compile src/ → dist/ (load dist/ in Chrome)
npm run dev          # Watch mode: rebuild on save
```

- **TypeScript 5.4** with strict mode; `@types/chrome` for Chrome API types
- **Vite 5** + **vite-plugin-web-extension 4** for MV3 multi-entry build
- Entry points discovered from `src/manifest.json`
- `public/` contents (icons, mappings.json) copied verbatim to `dist/`

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

1. Edit files in `src/`
2. Run `npm run build` (or `npm run dev` for watch mode) to compile to `dist/`
3. In Chrome: `chrome://extensions` → Developer Mode → Load unpacked → select **`dist/`**
4. After editing any `src/` file and rebuilding: click the refresh icon on the extension card
5. After editing `src/content.ts` or `src/manifest.json`: reload extension AND refresh the PassMed/Quesmed tab
6. Debug background: click "service worker" link on the extension card → DevTools console
7. Debug content script: open DevTools on the PassMed/Quesmed tab → Console

> The legacy `extension/` folder (plain JS) is still loadable if needed for comparison.

## Current State (as of 2026-03-13)

- **Phase A complete**: Full TypeScript + Vite build pipeline. Load `dist/` in Chrome.
- Fully functional end-to-end on PassMed; Quesmed URL structure unverified
- Auto-suggest: fires automatically on unmapped questions; Claude path (if API key set) searches by title→tag, fuzzy fallback otherwise
- Due/New badges on linked cards (AnkiConnect `is:due` / `is:new`)
- Session wrong tracking with review panel, history (last 10 sessions), and "Study in Anki"
- Popup: AnkiConnect status, Claude API key management, export/import mappings JSON
- Bundled `mappings.json` is empty; users build personal mappings via auto-suggest
- `mapping_builder.py` exists for offline bulk mapping, `--use-claude` flag stubbed

### Next phases
- **Phase B**: Supabase community mapping backend (shared DB, upload on SAVE_MAPPING, sync on startup)
- **Phase C**: Transformers.js semantic embeddings (local, IndexedDB, no API key)
- **Phase D**: AI card generation (Claude generates cloze cards for unmapped questions)
- **Phase E**: Chrome Side Panel analytics dashboard (React + Recharts)
- **Phase F**: Platform expansion (Pastest, OnExamination)
