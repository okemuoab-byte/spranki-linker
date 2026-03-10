#!/usr/bin/env python3
"""
scrape_passMed.py
─────────────────
Scrapes PassMed questions via their internal JSON API.
Much faster than HTML scraping — no browser needed.

Usage:
  python3 scrape_passMed.py --cookie "PHPSESSID=..." --start 1 --end 12000 --output passMed_questions.csv

Get your cookie string from Chrome DevTools:
  1. Open PassMed (logged in) → F12 → Network tab → refresh
  2. Click any request → Headers → Cookie → copy the full value

Interrupted runs resume automatically.
"""

import csv
import json
import re
import time
import random
import argparse
from pathlib import Path

try:
    import requests
except ImportError:
    raise SystemExit("❌ Run: pip3 install requests")

API_URL = "https://www.passmedicine.com/question/multi_ajax_question_data.php"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.passmedicine.com/question/questions.php",
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01",
}



def clean(text):
    """Strip HTML tags and normalise whitespace."""
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def parse_cookies(cookie_str):
    cookies = {}
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies


def load_done_qids(output_path):
    done = set()
    p = Path(output_path)
    if not p.exists():
        return done
    with open(p, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            qid = row.get("qid", "").strip()
            if qid:
                done.add(qid)
    return done


def fetch_question(session, qid):
    """
    Returns decoded question text, or None if QID doesn't exist.
    Raises on session expiry.
    """
    resp = session.get(API_URL, params={"q[]": qid}, timeout=15)

    if resp.status_code == 404:
        return None

    # Session expired — API redirects to login page
    if "login" in resp.url or resp.headers.get("content-type", "").startswith("text/html"):
        raise SessionExpired()

    try:
        data = resp.json()
    except json.JSONDecodeError:
        return None

    # Session expired — API returns 0 or False
    if data == 0 or data is False:
        raise SessionExpired()

    # Response structure: [[{...question dict...}]] or [] for invalid QID
    if not data or not data[0]:
        return None

    q = data[0][0] if isinstance(data[0], list) else data[0]

    # question field contains plain decoded text — no cipher needed
    question_text = q.get("question") or (
        q["questions"][0] if isinstance(q.get("questions"), list) and q["questions"] else ""
    )
    if not question_text:
        return None

    return {
        "qid": str(qid),
        "new_question_id": str(q.get("new_question_id") or ""),
        "title": clean(q.get("title") or ""),
        "question": clean(question_text),
    }


class SessionExpired(Exception):
    pass


def scrape(cookie_str, start, end, output, delay):
    cookies = parse_cookies(cookie_str)
    done_qids = load_done_qids(output)
    to_scrape = [q for q in range(start, end + 1) if str(q) not in done_qids]

    if not to_scrape:
        print("✅ All QIDs already scraped.")
        return

    print(f"📋 PassMed scraper (API mode)")
    print(f"   Range: {start}–{end} | Done: {len(done_qids)} | Remaining: {len(to_scrape)}\n")

    session = requests.Session()
    session.headers.update(HEADERS)
    session.cookies.update(cookies)

    file_exists = Path(output).exists()
    csv_file = open(output, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(csv_file, fieldnames=["qid", "new_question_id", "title", "question"])
    if not file_exists:
        writer.writeheader()

    stats = {"scraped": 0, "skipped": 0, "failed": 0}

    for i, qid in enumerate(to_scrape):
        try:
            text = fetch_question(session, qid)
            if text:
                writer.writerow(text)  # text is now a dict with qid, new_question_id, question
                csv_file.flush()
                stats["scraped"] += 1
            else:
                stats["skipped"] += 1

        except SessionExpired:
            print(f"\n⚠️  Session expired at QID {qid}.")
            print(f"   Get a fresh cookie from Chrome DevTools and rerun — it will resume from here.\n")
            break
        except Exception as e:
            print(f"   ⚠️  QID {qid}: {e}")
            stats["failed"] += 1

        if (i + 1) % 100 == 0:
            print(f"   [{i+1}/{len(to_scrape)}] scraped={stats['scraped']} "
                  f"skipped={stats['skipped']} failed={stats['failed']}")

        time.sleep(max(0.3, delay + random.uniform(-0.2, 0.2)))

    csv_file.close()

    total = stats["scraped"] + stats["skipped"] + stats["failed"]
    print(f"\n✅ Done! Processed {total} QIDs")
    print(f"   Scraped: {stats['scraped']} | Skipped: {stats['skipped']} | Failed: {stats['failed']}")
    print(f"   Output:  {output}")
    if stats["scraped"] > 0:
        print(f"\nNext step:")
        print(f"  python3 mapping_builder.py --source passMed --questions {output} --use-claude")


def main():
    parser = argparse.ArgumentParser(description="Scrape PassMed questions via API")
    parser.add_argument("--cookie", required=True, help="Cookie string from Chrome DevTools")
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--delay", type=float, default=0.5,
                        help="Seconds between requests (default: 0.5)")
    args = parser.parse_args()

    scrape(args.cookie, args.start, args.end, args.output, args.delay)


if __name__ == "__main__":
    main()
