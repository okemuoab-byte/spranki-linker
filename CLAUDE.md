# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Spranki Linker** is a Chrome Extension (Manifest V3) that links PassMed and Quesmed medical question bank questions to matching cards in the user's **Spranki Anki deck** via the AnkiConnect local API.

The extension shows a floating overlay on question pages with the linked Anki cards. If no mapping exists yet, it fuzzy-matches the question text + Anki tags to suggest cards from the user's deck, and saves confirmed links to `chrome.storage.local`.

## Architecture

```
extension/          ← Load this folder as unpacked extension in Chrome
  manifest.json     ← MV3: permissions, host_permissions, content_scripts, service_worker
  background.js     ← Service worker: AnkiConnect calls, mapping lookup, fuzzy scoring
  content.js        ← Injected into PassMed/Quesmed: QID extraction, overlay rendering
  mappings.json     ← Bundled QID→noteId/tag/search mappings (base; user entries override)
  popup.html/js     ← Extension popup: AnkiConnect status + reload button
  styles/
    overlay.css     ← Overlay UI styles (dark navy theme)
  icons/            ← icon16/48/128.png

mapping-tools/
  mapping_builder.py  ← Offline tool: fetches Spranki cards from Anki, fuzzy-matches CSV export
```

## Key Technical Details

**Supported platforms:**
- `https://www.passmedicine.com/*` — QID from `?q=` query param
- `https://quesmed.com/*` — QID from `/question/123` URL path or `[data-id]` DOM element

**AnkiConnect:** Local HTTP API at `http://localhost:8765`. Actions used: `findNotes`, `notesInfo`, `addTags`, `guiBrowse`, `version`.

**Anki deck name:** `!Spranki Clinical` (exact, case-sensitive, quoted in queries).

**Mapping resolution order (background.js `lookupCards`):**
1. `noteIds` array → direct note lookup
2. `tags` array → `findNotes` with `tag:X OR tag:Y`
3. `search` string → `findNotes` with `deck:"!Spranki Clinical" <search>`

**Mapping storage:** `mappings.json` is the bundled base. User-confirmed links go to `chrome.storage.local` under key `customMappings`. `getMappings()` deep-merges them (custom entries win per-QID). `cachedMappings` is a module-level cache; set to `null` to invalidate.

**SPA navigation:** PassMed/Quesmed are SPAs. Navigation is detected by patching `history.pushState` + `history.replaceState` + `popstate` event + `MutationObserver` fallback.

**Fuzzy scoring (`fuzzyScore`):** 60% tag-based, 40% text-based.
- Tags like `!Spranki Clinical::Cardiology::HeartFailure` → tokenise each `::` segment (skip deck prefix)
- Card fronts have HTML and cloze markers (`{{c1::answer::hint}}`) stripped before tokenising
- Tokens must be >3 chars; short words and stop words are dropped
- Top 3 suggestions shown

**Spranki card cache:** `sprankiCardCache` in background.js, 1-hour TTL, fetched in batches of 100.

## Message Types (content.js → background.js)

| Type | Payload | Response |
|------|---------|----------|
| `LOOKUP_CARDS` | `{platform, qid}` | `{cards, error?, ankiConnectDown?}` |
| `GET_SUGGESTIONS` | `{questionText}` | `{suggestions, ankiConnectDown?}` |
| `SAVE_MAPPING` | `{platform, qid, noteId, topic}` | `{ok}` |
| `OPEN_IN_ANKI` | `{noteId}` | (fire-and-forget) |
| `TAG_CARD` | `{noteId, tag}` | (fire-and-forget) |
| `TEST_ANKICONNECT` | — | `{ok, version?}` |
| `RELOAD_MAPPINGS` | — | `{ok}` |

## Development Workflow

1. Edit files in `extension/`
2. In Chrome: go to `chrome://extensions` → enable Developer Mode → Load unpacked → select `extension/` folder
3. After editing `background.js`: click the refresh icon on the extension card
4. After editing `content.js` or `manifest.json`: reload the extension AND refresh the PassMed/Quesmed tab
5. Debug background: click "service worker" link on the extension card → DevTools console
6. Debug content script: open DevTools on the PassMed/Quesmed tab → Console

## Current State (as of 2026-03-06)

- Extension is functional end-to-end
- Auto-suggest works: 🔍 button → fuzzy match → "Link this ✓" → saves to storage → re-renders with linked card
- Bundled `mappings.json` is empty (no community mappings yet); users build up personal mappings via auto-suggest
- `mapping_builder.py` exists for offline bulk mapping but is not yet integrated with Claude
- `--use-claude` flag in mapping_builder.py is stubbed (not implemented)
