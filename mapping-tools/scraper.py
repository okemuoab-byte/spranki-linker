#!/usr/bin/env python3
"""
scraper.py
──────────
Scrapes PassMed and Quesmed question text to CSV for use with mapping_builder.py.
Uses Playwright with a persistent browser profile (no repeated logins).

Installation:
  pip install playwright
  playwright install chromium

Usage:
  python3 scraper.py --source passMed --start 1 --end 12000 --output passMed_questions.csv
  python3 scraper.py --source quesmed  --start 1 --end 12000 --output quesmed_questions.csv

  Interrupted runs resume automatically — already-scraped QIDs are skipped.
"""

import asyncio
import csv
import random
import argparse
from pathlib import Path

try:
    from playwright.async_api import async_playwright, TimeoutError as PWTimeout
except ImportError:
    raise SystemExit("❌ Playwright not installed. Run: pip install playwright && playwright install chromium")


PLATFORMS = {
    "passMed": {
        "name": "PassMed",
        "login_url": "https://www.passmedicine.com/account/login.php",
        "home_url": "https://www.passmedicine.com/question/questions.php",
        "question_url": "https://www.passmedicine.com/question/questions.php?q={qid}",
        "ready_selector": "#question_only, .stem, .question-text, .vignette, [class*='questionText'], [class*='question-text']",
        # Element that only appears when logged in (on the home/questions page)
        "logged_in_selector": "#question_only, .question_nav, [class*='question'], form[name='qform']",
    },
    "quesmed": {
        "name": "Quesmed",
        "login_url": "https://quesmed.com/login",
        "home_url": "https://quesmed.com/questions",
        "question_url": "https://quesmed.com/questions/{qid}",
        "ready_selector": ".question-text, .stem, [class*='questionText'], [class*='question-text'], [class*='QuestionText']",
        "logged_in_selector": "[class*='question'], [class*='Question'], main",
    },
}

QUESTION_SELECTORS = [
    "#question_only",
    ".question-text", ".stem", ".question-stem",
    '[class*="questionText"]', '[class*="question-text"]',
    '[class*="question_text"]', '[class*="QuestionText"]',
    ".vignette", ".clinical-scenario",
]

PROFILES_DIR = Path(__file__).parent / ".profiles"


async def ensure_logged_in(page, platform_cfg):
    """Navigate to home page; if not logged in, pause for manual login."""
    await page.goto(platform_cfg["home_url"], wait_until="domcontentloaded", timeout=30_000)
    await page.wait_for_timeout(2000)

    # Check if we're on the login page or a logged-in page
    if "login" in page.url or "account" in page.url:
        already_logged_in = False
    else:
        try:
            await page.wait_for_selector(platform_cfg["logged_in_selector"], timeout=4_000)
            already_logged_in = True
        except PWTimeout:
            already_logged_in = False

    if already_logged_in:
        print(f"   ✅ Already logged in to {platform_cfg['name']}.\n")
    else:
        print(f"\n🔐 Not logged in to {platform_cfg['name']}.")
        print(f"   → Log in in the browser window that opened.")
        print(f"   → Once you're on the questions page, press ENTER here.\n")
        await page.goto(platform_cfg["login_url"], wait_until="domcontentloaded")
        input("   Press ENTER after logging in... ")
        print("   ✅ Session saved. Starting scrape...\n")


async def extract_question_text(page):
    for sel in QUESTION_SELECTORS:
        try:
            el = page.locator(sel).first
            if await el.count() > 0:
                text = (await el.inner_text()).strip()
                if len(text) > 30:
                    return text
        except Exception:
            continue

    # Heuristic fallback
    try:
        text = await page.evaluate("""() => {
            const blocks = [...document.querySelectorAll('p, td, div')]
                .filter(el => {
                    const t = el.innerText?.trim() || '';
                    return t.length > 80 && t.length < 2500 && el.children.length < 8;
                })
                .sort((a, b) => (b.innerText?.length || 0) - (a.innerText?.length || 0));
            const qBlock = blocks.find(el => el.innerText.trim().endsWith('?'));
            return (qBlock || blocks[0])?.innerText?.trim() || null;
        }""")
        if text and len(text) > 30:
            return text
    except Exception:
        pass

    return None


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


async def scrape(source, start, end, output, delay):
    platform_cfg = PLATFORMS[source]
    done_qids = load_done_qids(output)
    to_scrape = [qid for qid in range(start, end + 1) if str(qid) not in done_qids]

    if not to_scrape:
        print("✅ All QIDs in range already scraped.")
        return

    print(f"📋 {platform_cfg['name']} scraper")
    print(f"   Range: {start}–{end} | Already done: {len(done_qids)} | Remaining: {len(to_scrape)}")
    print(f"   Output: {output}\n")

    profile_dir = PROFILES_DIR / source
    profile_dir.mkdir(parents=True, exist_ok=True)

    file_exists = Path(output).exists()
    csv_file = open(output, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(csv_file, fieldnames=["qid", "question"])
    if not file_exists:
        writer.writeheader()

    stats = {"scraped": 0, "skipped": 0, "failed": 0}

    async with async_playwright() as pw:
        # Persistent context = real browser profile, session survives restarts
        context = await pw.chromium.launch_persistent_context(
            str(profile_dir),
            headless=False,
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ],
            ignore_default_args=["--enable-automation"],
        )
        # Hide webdriver property
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        page = await context.new_page()

        await ensure_logged_in(page, platform_cfg)

        for i, qid in enumerate(to_scrape):
            url = platform_cfg["question_url"].format(qid=qid)
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=20_000)

                try:
                    await page.wait_for_selector(platform_cfg["ready_selector"], timeout=8_000)
                except PWTimeout:
                    # No question content — invalid QID or session dropped
                    # Check if session dropped by looking for login form
                    login_visible = await page.locator("input[type='password']").count()
                    if login_visible:
                        print(f"\n   ⚠️  Session expired at QID {qid}. Log in again then press ENTER...")
                        input()
                        await page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                        await page.wait_for_selector(platform_cfg["ready_selector"], timeout=8_000)
                    else:
                        stats["skipped"] += 1
                        continue

                text = await extract_question_text(page)
                if text:
                    writer.writerow({"qid": str(qid), "question": text})
                    csv_file.flush()
                    stats["scraped"] += 1
                else:
                    stats["skipped"] += 1

            except PWTimeout:
                stats["failed"] += 1
            except Exception as e:
                print(f"   ⚠️  QID {qid}: {e}")
                stats["failed"] += 1

            if (i + 1) % 25 == 0:
                print(f"   [{i+1}/{len(to_scrape)}] scraped={stats['scraped']} "
                      f"skipped={stats['skipped']} failed={stats['failed']}")

            jitter = random.uniform(-0.3, 0.3)
            await asyncio.sleep(max(0.5, delay + jitter))

        await context.close()

    csv_file.close()

    total = stats["scraped"] + stats["skipped"] + stats["failed"]
    print(f"\n✅ Done! Processed {total} QIDs")
    print(f"   Scraped: {stats['scraped']} | Skipped: {stats['skipped']} | Failed: {stats['failed']}")
    print(f"   Output:  {output}")
    print(f"\nNext step:")
    print(f"  python3 mapping_builder.py --source {source} --questions {output} --use-claude")


def main():
    parser = argparse.ArgumentParser(description="Scrape PassMed/Quesmed questions to CSV")
    parser.add_argument("--source", choices=["passMed", "quesmed"], required=True)
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--delay", type=float, default=1.5)
    args = parser.parse_args()

    if args.start > args.end:
        raise SystemExit("❌ --start must be <= --end")

    asyncio.run(scrape(args.source, args.start, args.end, args.output, args.delay))


if __name__ == "__main__":
    main()
