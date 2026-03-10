#!/usr/bin/env python3
"""
mapping_builder.py
──────────────────
Builds PassMed/Quesmed → Spranki mapping using tag-based matching.

How it works:
1. Pulls all unique topic tags from the Spranki deck via AnkiConnect
2. For each question, asks Claude which tag best matches the topic
3. Stores the tag in the mapping — the extension uses it to findNotes by tag,
   returning ALL relevant cards for that topic automatically

Usage:
  python3 mapping_builder.py --source passMed --questions passMed_questions.csv --use-claude
  python3 mapping_builder.py --source quesmed  --questions quesmed_questions.csv --use-claude
"""

import json
import csv
import argparse
import os
import re
import urllib.request


ANKICONNECT_URL = "http://localhost:8765"


def anki_request(action, params=None):
    payload = json.dumps({"action": action, "version": 6, "params": params or {}}).encode()
    req = urllib.request.Request(ANKICONNECT_URL, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as res:
        data = json.loads(res.read())
    if data.get("error"):
        raise Exception(f"AnkiConnect error: {data['error']}")
    return data["result"]


def get_spranki_tags():
    """
    Pull all unique leaf tags from the Spranki deck.
    Tags look like '!SprankiClinical::Cardiology::HeartFailure'.
    Returns a sorted list of unique full tags.
    """
    print("Fetching Spranki tags from Anki...")
    note_ids = anki_request("findNotes", {"query": 'deck:"!Spranki Clinical"'})
    print(f"  Found {len(note_ids)} cards. Loading tags...")

    all_tags = set()
    batch_size = 100
    for i in range(0, len(note_ids), batch_size):
        notes = anki_request("notesInfo", {"notes": note_ids[i:i + batch_size]})
        for note in notes:
            for tag in note.get("tags", []):
                if "SprankiClinical" in tag or "Spranki" in tag:
                    all_tags.add(tag)

    tags = sorted(all_tags)
    print(f"  Found {len(tags)} unique Spranki tags.\n")
    return tags


def fuzzy_filter_tags(question_text, tags, top_n=25):
    """
    Pre-filter tags by word overlap with the question text.
    Returns (top_n tags, best_overlap_score).
    """
    q_words = set(re.findall(r'[a-z]{3,}', question_text.lower()))
    if not q_words:
        return tags[:top_n], 0

    scored = []
    for tag in tags:
        segments = tag.split("::")
        # Split CamelCase so AtopicDermatitis → atopic dermatitis
        tag_text = re.sub(r'([a-z])([A-Z])', r'\1 \2', " ".join(segments[1:]))
        tag_words = set(re.findall(r'[a-z]{3,}', tag_text.lower()))
        overlap = len(q_words & tag_words)
        scored.append((overlap, tag))

    scored.sort(reverse=True, key=lambda x: x[0])
    best_overlap = scored[0][0] if scored else 0
    return [tag for _, tag in scored[:top_n]], best_overlap


def claude_get_search(question_text, api_key):
    """
    Ask Claude to generate 1-3 Anki search keywords for the question's medical topic.
    Returns a search string like 'heart failure' or None.
    """
    try:
        import anthropic
    except ImportError:
        raise SystemExit("❌ anthropic package not installed. Run: pip3 install anthropic")

    client = anthropic.Anthropic(api_key=api_key)

    msg = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=20,
        messages=[{
            "role": "user",
            "content": (
                f"What is the core medical topic of this exam question? "
                f"Reply with 1-3 keywords only (e.g. 'atrial fibrillation' or 'breast cancer management'). "
                f"Reply 'none' only if it's a non-clinical topic (e.g. statistics, ethics).\n\n"
                f"Question: {question_text[:500]}"
            )
        }]
    )

    answer = msg.content[0].text.strip().lower()
    if answer == "none" or len(answer) > 60:
        return None
    return answer


def build_title_map(csv_path, tags, api_key, output_path):
    """
    Build a title→search mapping by asking Claude to map each unique PassMed
    title to the best Anki tag search. Since there are only ~300-500 unique
    titles across 12k questions, this is fast and highly accurate.

    Output: {"Atrial fibrillation": "tag:*Atrial* tag:*Fibrillation*", ...}
    """
    try:
        import anthropic
    except ImportError:
        raise SystemExit("❌ anthropic package not installed. Run: pip3 install anthropic")

    # Load existing output to allow resuming
    existing = {}
    try:
        with open(output_path) as f:
            existing = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # Collect unique titles from CSV
    with open(csv_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    titles = sorted(set(r.get("title", "").strip() for r in rows if r.get("title", "").strip()))
    to_process = [t for t in titles if t not in existing]
    print(f"Found {len(titles)} unique titles. Processing {len(to_process)} new ones...")

    # Build tag list summary for Claude (leaf segments only)
    tag_segments = sorted(set(
        seg
        for tag in tags
        for seg in tag.split("::")[1:]
        if seg
    ))
    tag_list_str = ", ".join(tag_segments[:200])  # cap to avoid huge prompts

    client = anthropic.Anthropic(api_key=api_key)

    for i, title in enumerate(to_process):
        try:
            msg = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=40,
                messages=[{
                    "role": "user",
                    "content": (
                        f"I have an Anki medical deck with tags like: {tag_list_str}\n\n"
                        f"PassMed question topic: '{title}'\n\n"
                        f"Write an Anki search using tag wildcards to find cards about this topic. "
                        f"Format: tag:*Word1* tag:*Word2* (1-3 tags). "
                        f"Use the most specific matching tag words from the list above. "
                        f"Reply with only the search string."
                    )
                }]
            )
            search = msg.content[0].text.strip()
            # Basic validation
            if not search.startswith("tag:") or len(search) > 120:
                search = None
        except Exception as e:
            print(f"\n⚠️  API error at '{title}': {e}")
            print(f"   Saving progress. Rerun to resume.\n")
            break

        existing[title] = search
        if (i + 1) % 20 == 0:
            print(f"  [{i+1}/{len(to_process)}] processed")
            with open(output_path, "w") as f:
                json.dump(existing, f, indent=2)

    with open(output_path, "w") as f:
        json.dump(existing, f, indent=2)

    mapped = sum(1 for v in existing.values() if v)
    print(f"\n✅ Title map: {len(existing)} titles, {mapped} mapped")
    print(f"   Output: {output_path}")
    return existing


def build_mapping_from_csv(source, csv_path, tags, use_claude, api_key, output_path, title_map=None):
    """Read question CSV and build search-based mappings. Resumes from existing output."""
    existing_output = {}
    try:
        with open(output_path) as f:
            existing_output = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    already_done = set((existing_output.get(source) or {}).keys())

    mapping = dict(existing_output.get(source) or {})

    with open(csv_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    to_process = [r for r in rows if str(r.get("new_question_id") or r.get("qid") or "") not in already_done]
    print(f"Processing {len(to_process)} questions (skipping {len(already_done)} already done)...")

    for i, row in enumerate(to_process):
        qid = row.get("new_question_id") or row.get("qid") or row.get("id") or row.get("question_id")
        question_text = row.get("question") or row.get("text") or row.get("stem", "")
        title = row.get("title", "").strip()

        if not qid:
            continue

        search_query = None

        # 1. Try title_map first (most accurate)
        if title_map and title:
            search_query = title_map.get(title)

        # 2. Fall back to Claude keyword extraction
        if not search_query and use_claude and question_text:
            try:
                search_query = claude_get_search(question_text, api_key)
            except Exception as e:
                print(f"\n⚠️  API error at QID {qid}: {e}")
                print(f"   Saving progress and stopping. Rerun to resume.\n")
                break

        if search_query:
            # If it's a raw keyword string (not already tag: format), convert it
            if not search_query.startswith("tag:"):
                search_query = " ".join(
                    f"tag:*{w.capitalize()}*" for w in search_query.split() if len(w) > 2
                )
            mapping[str(qid)] = {
                "noteIds": [],
                "tags": [],
                "search": search_query,
                "topic": title or question_text[:80],
                "confidence": 1.0,
                "contributor": "claude",
            }
        else:
            mapping[str(qid)] = {
                "noteIds": [],
                "tags": [],
                "topic": title or question_text[:80],
                "confidence": 0,
                "contributor": "needs-review",
                "_unmapped": True,
            }

        if (i + 1) % 50 == 0:
            mapped = sum(1 for m in mapping.values() if not m.get("_unmapped"))
            print(f"  [{i+1}/{len(to_process)}] mapped={mapped} unmapped={i+1+len(already_done)-mapped}")
            _save_output(output_path, source, mapping, existing_output)

    _save_output(output_path, source, mapping, existing_output)
    return mapping


def _save_output(output_path, source, mapping, existing_output):
    """Write current mapping state to output file."""
    out = dict(existing_output)
    out[source] = mapping
    with open(output_path, "w") as f:
        json.dump(out, f, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Build Spranki Linker mapping file")
    parser.add_argument("--source", choices=["passMed", "quesmed"])
    parser.add_argument("--questions", required=True, help="CSV with columns: new_question_id, title, question")
    parser.add_argument("--output", default="mapping_output.json")
    parser.add_argument("--use-claude", action="store_true", help="Use Claude API for tag matching")
    parser.add_argument("--build-title-map", action="store_true",
                        help="Build title→tag mapping from unique PassMed titles (run this first)")
    parser.add_argument("--title-map", default=None,
                        help="Path to title_map.json produced by --build-title-map")
    args = parser.parse_args()

    api_key = None
    if args.use_claude or args.build_title_map:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise SystemExit("❌ ANTHROPIC_API_KEY environment variable not set.")

    # Get all Spranki tags (needed for both modes)
    try:
        tags = get_spranki_tags()
    except Exception as e:
        print(f"\n❌ Could not connect to AnkiConnect: {e}")
        print("   Make sure Anki is open with the AnkiConnect add-on installed.")
        return

    # Mode 1: Build title→tag map (run once, shared across all users)
    if args.build_title_map:
        title_map_path = args.title_map or "title_map.json"
        build_title_map(args.questions, tags, api_key, title_map_path)
        print(f"\nNext: python3 mapping_builder.py --source passMed --questions {args.questions} "
              f"--title-map {title_map_path} --output mapping_output.json")
        return

    if not args.source:
        raise SystemExit("❌ --source is required when not using --build-title-map")

    # Mode 2: Build full QID→search mapping using title_map + optional Claude fallback
    title_map = None
    if args.title_map:
        try:
            with open(args.title_map) as f:
                title_map = json.load(f)
            print(f"Loaded title map: {len(title_map)} entries\n")
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print(f"⚠️  Could not load title map: {e}")

    new_mappings = build_mapping_from_csv(
        args.source, args.questions, tags, args.use_claude, api_key, args.output, title_map
    )

    total = len(new_mappings)
    mapped = sum(1 for m in new_mappings.values() if not m.get("_unmapped"))
    needs_review = total - mapped

    print(f"\n✅ Done!")
    print(f"   Total questions: {total}")
    print(f"   Mapped:          {mapped} ({round(mapped/total*100) if total else 0}%)")
    print(f"   Needs review:    {needs_review}")
    print(f"   Output:          {args.output}")
    print(f"\nNext: cp {args.output} ../extension/mappings.json")


if __name__ == "__main__":
    main()
