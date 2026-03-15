// ============================================================
// Spranki Linker — Content Script
// Detects PassMed / Quesmed question pages and shows Anki card overlay
// ============================================================

import { ICONS } from "./utils/icons";
import { escapeHTML } from "./utils/html";
import { buildOverlayHTML } from "./overlay/build";
import { makeDraggable } from "./overlay/drag";
import type { OverlayResponse, SourceConfig } from "./types";

// ── Platform config ───────────────────────────────────────────
function getPassMedQID(): string | null {
  const paramMatch = new URLSearchParams(window.location.search).get("q");
  if (paramMatch && /^[1-9]\d*$/.test(paramMatch)) return paramMatch;
  return null;
}

const SOURCES: Record<string, SourceConfig> = {
  passMed: {
    name: "PassMed",
    color: "#4f8ef7",
    extractQID: () => getPassMedQID(),
  },
  quesmed: {
    name: "Quesmed",
    color: "#7c5cbf",
    extractQID: () => {
      const urlMatch = window.location.href.match(/questions?\/(\d+)/i);
      if (urlMatch) return urlMatch[1];
      const domMatch = document.querySelector<HTMLElement>("[data-id], .question-number");
      return domMatch
        ? (domMatch.dataset.id ?? domMatch.textContent?.match(/\d+/)?.[0] ?? null)
        : null;
    },
  },
};

function detectPlatform(): string | null {
  const host = window.location.hostname;
  if (host.includes("passmedicine")) return "passMed";
  if (host.includes("quesmed")) return "quesmed";
  return null;
}

function extractQuestionText(): string | null {
  const knownSelectors = [
    "#question_only",
    ".question-text",
    ".stem",
    ".question-stem",
    '[class*="questionText"]',
    '[class*="question-text"]',
    '[class*="question_text"]',
    '[class*="QuestionText"]',
    ".vignette",
    ".clinical-scenario",
  ];
  for (const sel of knownSelectors) {
    const el = document.querySelector<HTMLElement>(sel);
    const text = el?.innerText?.trim();
    if (text && text.length > 30) return text;
  }

  const blocks = [...document.querySelectorAll<HTMLElement>("p, td, div")]
    .filter((el) => {
      const text = el.innerText?.trim() || "";
      return text.length > 80 && text.length < 2500 && el.children.length < 8;
    })
    .sort((a, b) => (b.innerText?.length || 0) - (a.innerText?.length || 0));

  const questionBlock = blocks.find((el) => el.innerText.trim().endsWith("?"));
  return (questionBlock || blocks[0])?.innerText?.trim() || null;
}

// ── Module-level state ────────────────────────────────────────
let currentQID: string | null = null;
let overlayInitialized = false;
let activePlatform: string | null = null;
let activeSource: SourceConfig | null = null;
let activeTitle: string | null = null;
let activeQuestion: unknown = null;
let sessionWrongCount = 0;
let lastAnsweredState: string | null = null;

// ── Overlay render ────────────────────────────────────────────
function renderOverlay(
  response: OverlayResponse,
  source: SourceConfig,
  qid: string | null,
  excludeNoteIds: Set<number> = new Set()
): void {
  document.getElementById("spranki-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "spranki-overlay";
  overlay.innerHTML = buildOverlayHTML(
    response,
    source,
    qid,
    excludeNoteIds,
    sessionWrongCount,
    lastAnsweredState
  );
  document.body.appendChild(overlay);

  makeDraggable(overlay);

  // Session review button
  overlay.querySelector("#spranki-session-btn")?.addEventListener("click", () => {
    showSessionReview(overlay);
  });

  // Manual mark wrong
  overlay.querySelector("#spranki-mark-wrong")?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (!currentQID) return;
    chrome.runtime.sendMessage(
      {
        type: "RECORD_WRONG",
        platform: activePlatform,
        qid: currentQID,
        title: activeTitle || "",
      },
      (res: { count?: number }) => {
        sessionWrongCount = res?.count ?? sessionWrongCount;
        btn.innerHTML = `${ICONS.xCircle}Marked wrong`;
        btn.disabled = true;
        lastAnsweredState = currentQID;
        const badge = overlay.querySelector<HTMLElement>(".spranki-session-badge");
        if (badge) {
          badge.innerHTML = `${ICONS.alertTriangle}${sessionWrongCount} wrong`;
          badge.classList.remove("spranki-session-empty");
        }
      }
    );
  });

  // Collapse toggle
  overlay.querySelector("#spranki-toggle")?.addEventListener("click", () => {
    const body = overlay.querySelector<HTMLElement>(".spranki-body")!;
    const isHidden = body.style.display === "none";
    body.style.display = isHidden ? "flex" : "none";
    const toggle = overlay.querySelector<HTMLElement>("#spranki-toggle")!;
    toggle.innerHTML = isHidden ? ICONS.chevronDown : ICONS.chevronRight;
  });

  // Open card in Anki
  overlay.querySelectorAll<HTMLButtonElement>(".spranki-open-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const prev = btn.innerHTML;
      btn.innerHTML = `${ICONS.check}Opening…`;
      btn.disabled = true;
      setTimeout(() => {
        btn.innerHTML = prev;
        btn.disabled = false;
      }, 1500);
      chrome.runtime.sendMessage({ type: "OPEN_IN_ANKI", noteId: btn.dataset.noteId });
    });
  });

  // Mark card reviewed
  overlay.querySelectorAll<HTMLButtonElement>(".spranki-tag-done").forEach((btn) => {
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "TAG_CARD",
        noteId: btn.dataset.noteId,
        tag: "sprankiReviewed",
      });
      btn.innerHTML = `${ICONS.checkCircle}Reviewed`;
      btn.disabled = true;
    });
  });

  // Link another card
  overlay.querySelector("#spranki-add-link")?.addEventListener("click", () => {
    const linkedIds = new Set(
      [...overlay.querySelectorAll<HTMLButtonElement>(".spranki-unlink")].map((b) =>
        Number(b.dataset.noteId)
      )
    );
    autoSuggest(activeSource!, currentQID!, activeQuestion, activeTitle, linkedIds);
  });

  // Unlink a card
  overlay.querySelectorAll<HTMLButtonElement>(".spranki-unlink").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.textContent = "…";
      btn.disabled = true;
      const savedQID = currentQID;
      chrome.runtime.sendMessage(
        {
          type: "REMOVE_FROM_MAPPING",
          platform: activePlatform,
          qid: savedQID,
          noteId: Number(btn.dataset.noteId),
        },
        () => {
          currentQID = null;
          checkAndRenderOverlay(activePlatform!, savedQID, activeTitle, activeQuestion);
        }
      );
    });
  });

  // Manual find matches button
  overlay.querySelector("#spranki-find-matches")?.addEventListener("click", () => {
    const questionText = extractQuestionText();
    const body = overlay.querySelector<HTMLElement>(".spranki-body")!;

    if (!questionText) {
      body.innerHTML = `<div class="spranki-notice">${ICONS.alertTriangle} Could not read question text.<br><small>Right-click the question → Inspect, then tell us the element class.</small></div>`;
      return;
    }

    body.innerHTML = `<div class="spranki-notice spranki-loading"><span class="spranki-spinner"></span>Searching your Spranki deck…</div>`;

    chrome.runtime.sendMessage(
      { type: "GET_SUGGESTIONS", questionText, title: activeTitle || "" },
      (response: OverlayResponse) => {
        if (chrome.runtime.lastError) {
          body.innerHTML = `<div class="spranki-notice">${ICONS.alertTriangle} ${escapeHTML(chrome.runtime.lastError.message ?? "")}</div>`;
          return;
        }
        renderOverlay(response, activeSource!, currentQID);
      }
    );
  });

  // Link suggestion buttons
  overlay.querySelectorAll<HTMLButtonElement>(".spranki-link-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.textContent = "Linking…";
      btn.disabled = true;
      const savedQID = currentQID;
      chrome.runtime.sendMessage(
        {
          type: "SAVE_MAPPING",
          platform: activePlatform,
          qid: savedQID,
          noteId: Number(btn.dataset.noteId),
          topic: btn.dataset.topic,
        },
        () => {
          currentQID = null;
          checkAndRenderOverlay(activePlatform!, savedQID, activeTitle, activeQuestion);
        }
      );
    });
  });
}

// ── Auto-suggest ──────────────────────────────────────────────
function autoSuggest(
  source: SourceConfig,
  qid: string,
  apiQuestion: unknown,
  apiTitle: string | null,
  excludeNoteIds: Set<number> = new Set()
): void {
  renderOverlay({ autoSearching: true }, source, qid);

  const trySearch = (attemptsLeft: number): void => {
    const questionText = (apiQuestion as string) || extractQuestionText();
    if (!questionText && attemptsLeft > 0) {
      setTimeout(() => trySearch(attemptsLeft - 1), 500);
      return;
    }
    if (!questionText) {
      renderOverlay({ error: "No mapping found" }, source, qid);
      return;
    }
    chrome.runtime.sendMessage(
      { type: "GET_SUGGESTIONS", questionText, title: apiTitle || "" },
      (response: OverlayResponse) => {
        if (chrome.runtime.lastError) {
          renderOverlay(
            { bgError: chrome.runtime.lastError.message },
            source,
            qid
          );
          return;
        }
        renderOverlay(response, source, qid, excludeNoteIds);
      }
    );
  };
  trySearch(6);
}

// ── Main overlay check ────────────────────────────────────────
async function checkAndRenderOverlay(
  platform: string,
  forcedQID?: string | null,
  passMedTitle?: string | null,
  passMedQuestion?: unknown
): Promise<void> {
  const source = SOURCES[platform];
  const qid = forcedQID !== undefined ? forcedQID : source.extractQID();

  if (overlayInitialized && qid === currentQID) return;
  overlayInitialized = true;
  currentQID = qid;

  if (!qid) {
    renderOverlay({ noQID: true }, source, null);
    return;
  }

  chrome.runtime.sendMessage(
    { type: "LOOKUP_CARDS", platform, qid },
    (response: OverlayResponse) => {
      if (chrome.runtime.lastError) {
        renderOverlay({ bgError: chrome.runtime.lastError.message }, source, qid);
        return;
      }
      if (response.error && !response.ankiConnectDown) {
        autoSuggest(source, qid, passMedQuestion, passMedTitle ?? null);
      } else {
        renderOverlay(response, source, qid);
      }
    }
  );
}

// ── Session review panel ──────────────────────────────────────
function showSessionReview(overlay: HTMLElement): void {
  const body = overlay.querySelector<HTMLElement>(".spranki-body")!;
  body.innerHTML = `<div class="spranki-notice spranki-loading"><span class="spranki-spinner"></span>Loading session review…</div>`;

  chrome.runtime.sendMessage(
    { type: "GET_SESSION_REVIEW", platform: activePlatform },
    (response: {
      wrongCount: number;
      groups: Array<{
        qid: string;
        title: string;
        cards: Array<{ noteId: number; front: string; tags: string[] }>;
      }>;
      allNoteIds: number[];
    }) => {
      if (chrome.runtime.lastError || !response) {
        body.innerHTML = `<div class="spranki-notice">${ICONS.alertTriangle} Could not load session data.</div>`;
        return;
      }

      const { wrongCount, groups, allNoteIds } = response;

      if (wrongCount === 0) {
        body.innerHTML = `
          <div class="spranki-notice">${ICONS.checkCircle} No wrong answers this session.<br><small>Keep going or check your history.</small></div>
          <div style="display:flex;gap:6px;margin-top:4px">
            <button id="spranki-show-history" class="spranki-btn spranki-secondary" style="font-size:11px">${ICONS.history}History</button>
            <button id="spranki-session-back" class="spranki-btn spranki-secondary" style="font-size:11px">${ICONS.arrowLeft}Back</button>
          </div>`;
      } else {
        const groupsHTML = groups
          .map((g) => {
            const label = g.title ? escapeHTML(g.title) : `Q${g.qid}`;
            const cardsHTML =
              g.cards.length > 0
                ? g.cards
                    .map((c) => {
                      const front =
                        c.front.length > 100 ? c.front.slice(0, 100) + "…" : c.front;
                      const tag = (c.tags || [])
                        .filter((t) => t.includes("Spranki"))
                        .map((t) => t.split("::").slice(-2).join(" · "))
                        .slice(0, 1)
                        .map(
                          (t) =>
                            `<span class="spranki-tag">${escapeHTML(t)}</span>`
                        )
                        .join("");
                      return `<div class="spranki-card" style="border-color:rgba(251,146,60,0.3);margin-top:4px">
                        <div class="spranki-card-title">${escapeHTML(front)}</div>
                        <div class="spranki-card-tags">${tag}</div>
                      </div>`;
                    })
                    .join("")
                : `<div style="font-size:11px;color:rgba(200,210,240,0.4);padding:4px 0">No linked card yet</div>`;

            return `
              <div style="margin-bottom:8px">
                <div style="font-size:10px;font-weight:700;color:#f87171;margin-bottom:2px;display:flex;align-items:center;gap:4px">${ICONS.xCircle}${label}</div>
                ${cardsHTML}
              </div>`;
          })
          .join("");

        body.innerHTML = `
          <div style="font-size:11px;color:#f87171;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:4px">${ICONS.alertTriangle}${wrongCount} wrong this session</div>
          ${groupsHTML}
          <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
            ${
              allNoteIds?.length
                ? `
              <button id="spranki-study-session" class="spranki-btn" style="font-size:11px;background:#7c5cbf">${ICONS.rotateCcw}Study in Anki</button>
              <button id="spranki-open-session" class="spranki-btn spranki-secondary" style="font-size:11px">${ICONS.externalLink}Browse cards</button>
            `
                : ""
            }
            <button id="spranki-clear-review-tag" class="spranki-btn spranki-secondary" style="font-size:11px;color:rgba(200,210,240,0.5)">${ICONS.trash}Clear review queue</button>
            <button id="spranki-clear-session" class="spranki-btn spranki-secondary" style="font-size:11px;color:#f87171">${ICONS.trash}Clear &amp; save</button>
            <button id="spranki-show-history" class="spranki-btn spranki-secondary" style="font-size:11px">${ICONS.history}History</button>
            <button id="spranki-session-back" class="spranki-btn spranki-secondary" style="font-size:11px">${ICONS.arrowLeft}Back</button>
          </div>`;
      }

      body.querySelector("#spranki-study-session")?.addEventListener("click", () => {
        const btn = body.querySelector<HTMLButtonElement>("#spranki-study-session")!;
        btn.innerHTML = `<span class="spranki-spinner"></span>Tagging…`;
        btn.disabled = true;
        chrome.runtime.sendMessage(
          { type: "STUDY_SESSION_IN_ANKI", noteIds: allNoteIds },
          (res: { ok: boolean }) => {
            if (res?.ok) {
              btn.innerHTML = `${ICONS.checkCircle}Opening Anki`;
            } else {
              btn.innerHTML = `${ICONS.alertTriangle}Failed`;
              btn.disabled = false;
            }
          }
        );
      });

      body.querySelector("#spranki-open-session")?.addEventListener("click", () => {
        chrome.runtime.sendMessage({
          type: "OPEN_SESSION_IN_ANKI",
          noteIds: allNoteIds,
        });
      });

      body.querySelector("#spranki-clear-review-tag")?.addEventListener("click", () => {
        const btn = body.querySelector<HTMLButtonElement>("#spranki-clear-review-tag")!;
        btn.innerHTML = `<span class="spranki-spinner"></span>Clearing…`;
        btn.disabled = true;
        chrome.runtime.sendMessage(
          { type: "CLEAR_REVIEW_TAG" },
          (res: { ok: boolean; cleared: number }) => {
            if (res?.ok) {
              btn.innerHTML =
                res.cleared > 0
                  ? `${ICONS.checkCircle}Cleared ${res.cleared} cards`
                  : `${ICONS.checkCircle}Queue already empty`;
            } else {
              btn.innerHTML = `${ICONS.alertTriangle}Failed`;
              btn.disabled = false;
            }
          }
        );
      });

      body.querySelector("#spranki-clear-session")?.addEventListener("click", () => {
        chrome.runtime.sendMessage(
          { type: "CLEAR_SESSION", platform: activePlatform },
          () => {
            sessionWrongCount = 0;
            const badge = overlay.querySelector<HTMLElement>(".spranki-session-badge");
            if (badge) {
              badge.innerHTML = `${ICONS.history}Session`;
              badge.classList.add("spranki-session-empty");
            }
            showSessionReview(overlay);
          }
        );
      });

      body.querySelector("#spranki-show-history")?.addEventListener("click", () => {
        showSessionHistory(overlay);
      });

      body.querySelector("#spranki-session-back")?.addEventListener("click", () => {
        const savedQID = currentQID;
        currentQID = null;
        checkAndRenderOverlay(activePlatform!, savedQID, activeTitle, activeQuestion);
      });
    }
  );
}

// ── Session history panel ─────────────────────────────────────
function showSessionHistory(overlay: HTMLElement): void {
  const body = overlay.querySelector<HTMLElement>(".spranki-body")!;
  body.innerHTML = `<div class="spranki-notice spranki-loading"><span class="spranki-spinner"></span>Loading history…</div>`;

  chrome.runtime.sendMessage(
    { type: "GET_SESSION_HISTORY", platform: activePlatform },
    (response: {
      history: Array<{
        date: string;
        wrongCount: number;
        questions: Array<{ qid: string; title: string }>;
      }>;
    }) => {
      if (chrome.runtime.lastError || !response) {
        body.innerHTML = `<div class="spranki-notice">${ICONS.alertTriangle} Could not load history.</div>`;
        return;
      }

      const { history } = response;

      if (!history.length) {
        body.innerHTML = `
          <div class="spranki-notice">${ICONS.history} No past sessions yet.<br><small>Clear a session to save it here.</small></div>
          <button id="spranki-history-back" class="spranki-btn spranki-secondary" style="font-size:11px;margin-top:4px">${ICONS.arrowLeft}Back</button>`;
      } else {
        const historyHTML = history
          .map((entry, i) => {
            const formattedDate = new Date(entry.date + "T12:00:00").toLocaleDateString(
              "en-GB",
              { day: "numeric", month: "short", year: "numeric" }
            );
            const questionsHTML = entry.questions
              .map(
                (q) =>
                  `<div style="font-size:11px;color:rgba(220,220,240,0.6);padding:2px 0 2px 8px;border-left:2px solid rgba(251,146,60,0.3)">
                  ${escapeHTML(q.title || `Q${q.qid}`)}
                </div>`
              )
              .join("");
            return `
              <div class="spranki-history-entry" data-index="${i}">
                <div class="spranki-history-header">
                  <span style="font-size:11px;font-weight:700;color:#e0e4f4">${formattedDate}</span>
                  <span style="font-size:10px;color:#f87171;font-weight:700;display:inline-flex;align-items:center;gap:3px">${ICONS.xCircle}${entry.wrongCount} wrong</span>
                  <span class="spranki-history-toggle" style="color:rgba(200,210,240,0.5);cursor:pointer;margin-left:auto;display:inline-flex;align-items:center">${ICONS.chevronDown}</span>
                </div>
                <div class="spranki-history-questions" style="display:none;margin-top:4px;gap:3px">
                  ${questionsHTML}
                </div>
              </div>`;
          })
          .join("");

        body.innerHTML = `
          <div style="font-size:11px;color:rgba(200,210,240,0.6);margin-bottom:6px">Last ${history.length} session${history.length > 1 ? "s" : ""}</div>
          ${historyHTML}
          <button id="spranki-history-back" class="spranki-btn spranki-secondary" style="font-size:11px;margin-top:6px">${ICONS.arrowLeft}Back</button>`;

        body.querySelectorAll<HTMLElement>(".spranki-history-entry").forEach((entry) => {
          entry.querySelector(".spranki-history-header")?.addEventListener("click", () => {
            const questions = entry.querySelector<HTMLElement>(".spranki-history-questions")!;
            const toggle = entry.querySelector<HTMLElement>(".spranki-history-toggle")!;
            const isHidden = questions.style.display === "none";
            questions.style.display = isHidden ? "flex" : "none";
            toggle.innerHTML = isHidden ? ICONS.chevronDown : ICONS.chevronRight;
          });
        });
      }

      body.querySelector("#spranki-history-back")?.addEventListener("click", () => {
        showSessionReview(overlay);
      });
    }
  );
}

// ── Init ──────────────────────────────────────────────────────
async function init(): Promise<void> {
  const platform = detectPlatform();
  if (!platform) return;

  activePlatform = platform;
  activeSource = SOURCES[platform];

  chrome.storage.local.get("sessionWrong", (stored) => {
    sessionWrongCount = Object.keys(
      ((stored.sessionWrong as Record<string, Record<string, string>>) || {})[platform] || {}
    ).length;
  });

  if (platform !== "passMed") {
    await checkAndRenderOverlay(platform);
  } else {
    renderOverlay({ noQID: true }, SOURCES.passMed, null);
  }

  if (platform === "passMed") {
    const pollInterval = setInterval(() => {
      if (!chrome.runtime?.id) {
        clearInterval(pollInterval);
        return;
      }
      try {
        chrome.runtime.sendMessage(
          { type: "GET_PASSMED_QID" },
          (response: {
            qid?: string | null;
            title?: string | null;
            question?: unknown;
            answeredCorrectly?: boolean | null;
          }) => {
            if (chrome.runtime.lastError) return;
            const { qid, title, question, answeredCorrectly } = response || {};

            if (qid && answeredCorrectly === false && lastAnsweredState !== qid) {
              lastAnsweredState = qid;
              chrome.runtime.sendMessage(
                {
                  type: "RECORD_WRONG",
                  platform,
                  qid,
                  title: activeTitle || "",
                },
                (res: { count?: number }) => {
                  sessionWrongCount = res?.count ?? sessionWrongCount;
                  const badge = document.getElementById("spranki-session-btn");
                  if (badge) {
                    badge.innerHTML = `${ICONS.alertTriangle}${sessionWrongCount} wrong`;
                    badge.classList.remove("spranki-session-empty");
                  }
                }
              );
            }

            if (qid && qid !== currentQID) {
              currentQID = null;
              lastAnsweredState = null;
              activeTitle = title ?? null;
              activeQuestion = question ?? null;
              checkAndRenderOverlay(platform, qid, activeTitle, activeQuestion);
            }
          }
        );
      } catch {
        clearInterval(pollInterval);
      }
    }, 1000);
  }

  const onNavigate = async (): Promise<void> => {
    currentQID = null;
    await checkAndRenderOverlay(platform);
  };

  const origPush = history.pushState.bind(history);
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    origPush(...args);
    void onNavigate();
  };

  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    origReplace(...args);
    void onNavigate();
  };

  window.addEventListener("popstate", onNavigate);

  let lastURL = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastURL) {
      lastURL = window.location.href;
      void onNavigate();
    }
  }).observe(document.body, { childList: true, subtree: true });
}

void init();
