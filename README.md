# 🃏 Spranki Linker

**Links PassMed & Quesmed questions to Spranki Anki deck cards — the UK equivalent of AnKing's UWorld integration.**

When you open a PassMed or Quesmed question, a floating panel shows you the matching Spranki cards so you can review them in Anki immediately.

---

## Weekend Setup (Day 1 — Saturday)

### Step 1: Install AnkiConnect into Anki
1. Open Anki
2. Tools → Add-ons → Get Add-ons
3. Enter code: **2055492159**
4. Restart Anki
5. AnkiConnect now runs a local API at `http://localhost:8765`

### Step 2: Load the Chrome Extension (Dev Mode)
1. Open Chrome → `chrome://extensions`
2. Enable **Developer Mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `/extension` folder from this repo
5. The 🃏 icon should appear in your toolbar

### Step 3: Test it
1. Keep Anki open (AnkiConnect needs Anki running)
2. Open a PassMed question
3. The floating Spranki panel should appear bottom-right

---

## Weekend Setup (Day 2 — Sunday): Build Your First Mappings

The tool works but needs real QID → Anki note ID mappings. Two ways to do this:

### Option A: Manual mapping (fast, high quality)
Open `extension/mappings.json` and add entries:
```json
{
  "passMed": {
    "1234": {
      "tags": ["Spranki::Cardiovascular::HeartFailure"],
      "topic": "Heart failure management",
      "contributor": "YOUR_NAME"
    }
  }
}
```
To find the right Spranki tag: open Anki → Browse → find the card → copy its tags.

### Option B: Semi-automated (faster at scale)
```bash
cd mapping-tools
pip install -r requirements.txt

# Export questions from PassMed as CSV (qid, question columns)
python mapping_builder.py --source passMed --questions passMed_export.csv
```

---

## Architecture

```
PassMed/Quesmed tab
       │
       ▼
Chrome Extension (content.js)
  - Detects question page
  - Extracts QID from URL/DOM
  - Sends to background
       │
       ▼
background.js
  - Looks up QID in mappings.json
  - Calls AnkiConnect API (localhost:8765)
  - Returns card data
       │
       ▼
Overlay Panel
  - Shows linked Spranki cards
  - "Open in Anki" → opens card browser
  - "Mark Done" → tags card in Anki
```

---

## Mapping Format

```json
{
  "passMed": {
    "<QID>": {
      "noteIds": [1234567890],       // Direct Anki note IDs (most reliable)
      "tags": ["Spranki::Cardio"],   // OR match by tag
      "search": "heart failure",     // OR match by search query
      "topic": "Heart failure Mx",   // Human-readable label
      "contributor": "username"
    }
  },
  "quesmed": {
    "<QID>": { ... }
  }
}
```

---

## Contributing Mappings

This tool only becomes powerful with community mappings. 

1. Fork the repo
2. Add your mappings to `extension/mappings.json`
3. Open a PR with the title `Mappings: [PassMed/Quesmed] Q[XXX]-Q[XXX]`

Or use the GitHub issue template (there's a **+ Improve this mapping** link in the overlay itself).

---

## Roadmap

- [ ] Detect URL changes in PassMed/Quesmed SPAs
- [ ] Sync "questions done" back to Anki tags automatically
- [ ] Community mapping server (GitHub-hosted JSON, auto-updated)
- [ ] AI-assisted mapping using Claude API
- [ ] Support for additional UK question banks (BMJ OnExamination, etc.)
- [ ] Firefox port

---

## License

MIT — use freely, contribute back.
