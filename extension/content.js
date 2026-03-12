// ============================================================
// Spranki Linker - Content Script
// Detects PassMed / Quesmed question pages and shows Anki card overlay
// ============================================================

// ── Lucide icons (paths extracted from lucide-react v0.462.0) ─
const _ico = (paths, size = 12) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  chevronDown:   _ico(`<path d="m6 9 6 6 6-6"/>`, 14),
  chevronRight:  _ico(`<path d="m9 18 6-6-6-6"/>`, 14),
  x:             _ico(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`, 13),
  arrowLeft:     _ico(`<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`),
  check:         _ico(`<path d="M20 6 9 17l-5-5"/>`),
  checkCircle:   _ico(`<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`),
  externalLink:  _ico(`<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`),
  link:          _ico(`<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>`),
  clock:         _ico(`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`),
  alertTriangle: _ico(`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`),
  trash:         _ico(`<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>`),
  plusCircle:    _ico(`<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>`),
  search:        _ico(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`),
  history:       _ico(`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`),
  bookOpen:      _ico(`<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>`),
  xCircle:       _ico(`<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>`),
  sparkles:      _ico(`<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>`),
  rotateCcw:     _ico(`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`),
};

// ── PassMed QID reader ───────────────────────────────────────
// Used only for direct-link navigation (e.g. passmedicine.com?q=1234).
// Quiz mode always has ?q=0, so QID is read via background.js executeScript polling instead.
function getPassMedQID() {
  const paramMatch = new URLSearchParams(window.location.search).get("q");
  if (paramMatch && /^[1-9]\d*$/.test(paramMatch)) return paramMatch;
  return null;
}

const SOURCES = {
  passMed: {
    name: "PassMed",
    color: "#4f8ef7",
    extractQID: () => getPassMedQID()
  },
  quesmed: {
    name: "Quesmed",
    color: "#7c5cbf",
    extractQID: () => {
      const urlMatch = window.location.href.match(/questions?\/(\d+)/i);
      if (urlMatch) return urlMatch[1];

      const domMatch = document.querySelector('[data-id], .question-number');
      return domMatch ? domMatch.dataset.id || domMatch.textContent.match(/\d+/)?.[0] : null;
    }
  }
};

// ── Detect which platform we're on ──────────────────────────
function detectPlatform() {
  const host = window.location.hostname;
  if (host.includes("passmedicine")) return "passMed";
  if (host.includes("quesmed")) return "quesmed";
  return null;
}

// ── Extract question text from the page ─────────────────────
function extractQuestionText() {
  // Try specific selectors first — update once PassMed DOM is confirmed
  const knownSelectors = [
    "#question_only",
    ".question-text", ".stem", ".question-stem",
    '[class*="questionText"]', '[class*="question-text"]', '[class*="question_text"]',
    '[class*="QuestionText"]', ".vignette", ".clinical-scenario",
  ];
  for (const sel of knownSelectors) {
    const el = document.querySelector(sel);
    const text = el?.innerText?.trim();
    if (text && text.length > 30) return text;
  }

  // Heuristic: find the largest readable text block on the page.
  // Question stems are typically 100-2000 chars and have few direct children.
  const blocks = [...document.querySelectorAll("p, td, div")]
    .filter(el => {
      const text = el.innerText?.trim() || "";
      return text.length > 80 && text.length < 2500 && el.children.length < 8;
    })
    .sort((a, b) => (b.innerText?.length || 0) - (a.innerText?.length || 0));

  // Prefer a block that ends with a question mark (it's asking something)
  const questionBlock = blocks.find(el => el.innerText.trim().endsWith("?"));
  return (questionBlock || blocks[0])?.innerText?.trim() || null;
}

// ── Module-level state ───────────────────────────────────────
let currentQID = null;
let overlayInitialized = false;
let activePlatform = null;
let activeSource = null;
let activeTitle = null;
let activeQuestion = null;
let sessionWrongCount = 0;        // count of wrong answers this session
let lastAnsweredState = null;     // tracks last known answeredCorrectly to avoid double-recording

// ── Main init ────────────────────────────────────────────────
async function init() {
  const platform = detectPlatform();
  if (!platform) return;

  activePlatform = platform;
  activeSource = SOURCES[platform];

  // Restore wrong count from storage so badge is accurate after page refresh
  chrome.storage.local.get("sessionWrong", stored => {
    sessionWrongCount = Object.keys((stored.sessionWrong || {})[platform] || {}).length;
  });

  // For PassMed, skip the initial extractQID() call — it always returns null in quiz mode
  // (?q=0). The polling loop below reads the real QID from window.question_data instead.
  // For Quesmed, the QID is in the URL so initial render works immediately.
  if (platform !== "passMed") {
    await checkAndRenderOverlay(platform);
  } else {
    // Show a minimal "waiting" overlay immediately so the user knows the extension is active.
    renderOverlay({ noQID: true }, SOURCES.passMed, null);
  }

  // PassMed quiz mode keeps URL at ?q=0 and loads questions via window.question_data.
  // Poll the background (which uses chrome.scripting.executeScript in MAIN world) to
  // get the real new_question_id. This is the reliable MV3 way — no bridge file needed.
  if (platform === "passMed") {
    const pollInterval = setInterval(() => {
      if (!chrome.runtime?.id) {
        clearInterval(pollInterval);
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: "GET_PASSMED_QID" }, (response) => {
          if (chrome.runtime.lastError) return;
          const { qid, title, question, answeredCorrectly } = response || {};

          // Auto-record wrong answer when detected (only once per question)
          if (qid && answeredCorrectly === false && lastAnsweredState !== qid) {
            lastAnsweredState = qid;
            chrome.runtime.sendMessage({ type: "RECORD_WRONG", platform, qid, title: activeTitle || "" }, (res) => {
              sessionWrongCount = res?.count ?? sessionWrongCount;
              // Update the session badge in overlay if visible
              const badge = document.getElementById("spranki-session-btn");
              if (badge) badge.textContent = `${sessionWrongCount} wrong`;
            });
          }

          if (qid && qid !== currentQID) {
            currentQID = null;
            lastAnsweredState = null; // reset answer tracking for new question
            activeTitle = title || null;
            activeQuestion = question || null;
            checkAndRenderOverlay(platform, qid, activeTitle, activeQuestion);
          }
        });
      } catch (e) {
        clearInterval(pollInterval);
      }
    }, 1000);
  }

  const onNavigate = async () => {
    currentQID = null;
    await checkAndRenderOverlay(platform);
  };

  // Patch pushState / replaceState — primary SPA navigation mechanism
  const origPush = history.pushState.bind(history);
  history.pushState = function (...args) {
    origPush(...args);
    onNavigate();
  };

  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    origReplace(...args);
    onNavigate();
  };

  // Back / forward buttons
  window.addEventListener("popstate", onNavigate);

  // MutationObserver as final fallback
  let lastURL = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastURL) {
      lastURL = window.location.href;
      onNavigate();
    }
  }).observe(document.body, { childList: true, subtree: true });
}

async function checkAndRenderOverlay(platform, forcedQID, passMedTitle, passMedQuestion) {
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
    (response) => {
      if (chrome.runtime.lastError) {
        renderOverlay({ bgError: chrome.runtime.lastError.message }, source, qid);
        return;
      }
      // No mapping found — auto-suggest immediately instead of showing a button
      if (response.error && !response.ankiConnectDown) {
        autoSuggest(source, qid, passMedQuestion, passMedTitle);
      } else {
        renderOverlay(response, source, qid);
      }
    }
  );
}

// ── Auto-suggest on load ─────────────────────────────────────
// excludeNoteIds: Set of noteIds already linked to this question — omit from suggestions
function autoSuggest(source, qid, apiQuestion, apiTitle, excludeNoteIds = new Set()) {
  renderOverlay({ autoSearching: true }, source, qid);

  // Prefer question text from window.question_data (already decoded, no DOM needed).
  // Fall back to DOM extraction for Quesmed or if API data isn't available yet.
  const trySearch = (attemptsLeft) => {
    const questionText = apiQuestion || extractQuestionText();
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
      (response) => {
        if (chrome.runtime.lastError) {
          renderOverlay({ bgError: chrome.runtime.lastError.message }, source, qid);
          return;
        }
        renderOverlay(response, source, qid, excludeNoteIds);
      }
    );
  };
  trySearch(6);
}

// ── Overlay rendering ────────────────────────────────────────
function renderOverlay(response, source, qid, excludeNoteIds = new Set()) {
  document.getElementById("spranki-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "spranki-overlay";
  overlay.innerHTML = buildOverlayHTML(response, source, qid, excludeNoteIds);
  document.body.appendChild(overlay);

  makeDraggable(overlay);

  // Session review button (header badge)
  overlay.querySelector("#spranki-session-btn")?.addEventListener("click", () => {
    showSessionReview(overlay);
  });

  // Manual "Mark question wrong" button
  overlay.querySelector("#spranki-mark-wrong")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (!currentQID) return;
    chrome.runtime.sendMessage({ type: "RECORD_WRONG", platform: activePlatform, qid: currentQID, title: activeTitle || "" }, (res) => {
      sessionWrongCount = res?.count ?? sessionWrongCount;
      btn.innerHTML = `${ICONS.xCircle}Marked wrong`;
      btn.disabled = true;
      lastAnsweredState = currentQID;
      // Update badge
      const badge = overlay.querySelector(".spranki-session-badge");
      if (badge) badge.innerHTML = `${ICONS.alertTriangle}${sessionWrongCount} wrong`;
    });
  });

  // Collapse toggle
  overlay.querySelector("#spranki-toggle")?.addEventListener("click", () => {
    const body = overlay.querySelector(".spranki-body");
    const isHidden = body.style.display === "none";
    body.style.display = isHidden ? "flex" : "none";
    overlay.querySelector("#spranki-toggle").innerHTML = isHidden ? ICONS.chevronDown : ICONS.chevronRight;
  });

  // Open card in Anki browser
  overlay.querySelectorAll(".spranki-open-card").forEach(btn => {
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_IN_ANKI", noteId: btn.dataset.noteId });
    });
  });

  // Mark card reviewed in Anki
  overlay.querySelectorAll(".spranki-tag-done").forEach(btn => {
    btn.addEventListener("click", () => {
      const tag = `sprankiReviewed`;
      chrome.runtime.sendMessage({ type: "TAG_CARD", noteId: btn.dataset.noteId, tag });
      btn.innerHTML = `${ICONS.checkCircle}Reviewed`;
      btn.disabled = true;
    });
  });

  // "Link another card" button (shown on linked cards view)
  overlay.querySelector("#spranki-add-link")?.addEventListener("click", () => {
    // Collect noteIds of cards already linked so they don't appear as suggestions
    const linkedIds = new Set(
      [...overlay.querySelectorAll(".spranki-unlink")].map(b => Number(b.dataset.noteId))
    );
    autoSuggest(activeSource, currentQID, activeQuestion, activeTitle, linkedIds);
  });

  // × Remove a linked card
  overlay.querySelectorAll(".spranki-unlink").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.textContent = "…";
      btn.disabled = true;
      const savedQID = currentQID;
      chrome.runtime.sendMessage(
        { type: "REMOVE_FROM_MAPPING", platform: activePlatform, qid: savedQID, noteId: Number(btn.dataset.noteId) },
        () => {
          currentQID = null;
          checkAndRenderOverlay(activePlatform, savedQID, activeTitle, activeQuestion);
        }
      );
    });
  });

  // "Find matching Spranki cards" button
  overlay.querySelector("#spranki-find-matches")?.addEventListener("click", () => {
    const questionText = extractQuestionText();
    const body = overlay.querySelector(".spranki-body");

    if (!questionText) {
      body.innerHTML = `<div class="spranki-notice">${ICONS.alertTriangle} Could not read question text.<br><small>Right-click the question → Inspect, then tell us the element class.</small></div>`;
      return;
    }

    body.innerHTML = `<div class="spranki-notice spranki-loading"><span class="spranki-spinner"></span>Searching your Spranki deck…</div>`;

    chrome.runtime.sendMessage(
      { type: "GET_SUGGESTIONS", questionText, title: activeTitle || "" },
      (response) => {
        if (chrome.runtime.lastError) {
          body.innerHTML = `<div class="spranki-notice">${ICONS.alertTriangle} ${escapeHTML(chrome.runtime.lastError.message)}</div>`;
          return;
        }
        renderOverlay(response, activeSource, currentQID);
      }
    );
  });

  // "Link this card" buttons on suggestions
  overlay.querySelectorAll(".spranki-link-card").forEach(btn => {
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
          // Re-run the full lookup with the saved QID — should now find the mapping
          currentQID = null;
          checkAndRenderOverlay(activePlatform, savedQID, activeTitle, activeQuestion);
        }
      );
    });
  });
}

// ── HTML builder ─────────────────────────────────────────────
function buildOverlayHTML(response, source, qid, excludeNoteIds = new Set()) {
  const { cards, error, ankiConnectDown, noQID, bgError, suggestions, autoSearching } = response || {};

  let bodyHTML = "";

  if (autoSearching) {
    bodyHTML = `<div class="spranki-notice spranki-loading"><span class="spranki-spinner"></span>Searching your Spranki deck…</div>`;

  } else if (noQID) {
    const path = window.location.pathname + window.location.search;
    bodyHTML = `<div class="spranki-notice">${ICONS.clock} Waiting for a question.<br><small>${escapeHTML(path)}</small></div>`;

  } else if (bgError) {
    bodyHTML = `<div class="spranki-notice">${ICONS.alertTriangle} Extension error.<br><small>${escapeHTML(bgError)}</small></div>`;

  } else if (ankiConnectDown) {
    bodyHTML = `<div class="spranki-notice">${ICONS.alertTriangle} AnkiConnect not running.<br><small>Open Anki with the AnkiConnect add-on installed.</small></div>`;

  } else if (suggestions) {
    // Auto-suggest results — exclude cards already linked to this question
    const filtered = suggestions.filter(c => !excludeNoteIds.has(c.noteId));
    if (filtered.length === 0) {
      bodyHTML = `<div class="spranki-notice">${ICONS.search} No matching card found in your Spranki deck for this topic.<br><small>This question may not have a linked card yet.</small></div>`;
    } else {
      bodyHTML = filtered.map(card => `
        <div class="spranki-suggestion">
          <div class="spranki-card-title">${escapeHTML(card.front.slice(0, 130))}${card.front.length > 130 ? "…" : ""}</div>
          <div class="spranki-suggestion-meta">
            <span class="spranki-score">${Math.round(card.score * 100)}% match</span>
            <span class="spranki-card-tags">${card.tags.slice(0, 2).map(t => `<span class="spranki-tag">${escapeHTML(t.split("::").pop())}</span>`).join("")}</span>
          </div>
          <div class="spranki-card-actions">
            <button class="spranki-btn spranki-open-card" data-note-id="${card.noteId}">${ICONS.externalLink}Preview</button>
            <button class="spranki-btn spranki-link-card" data-note-id="${card.noteId}" data-topic="${escapeHTML(card.front.slice(0, 80))}">${ICONS.link}Link</button>
          </div>
        </div>
      `).join("");
    }

  } else if (error) {
    bodyHTML = `
      <div class="spranki-notice">${ICONS.search} No mapping yet for Q${qid}.<br><small>Link a card from your deck below.</small></div>
      <button id="spranki-find-matches" class="spranki-btn spranki-find-btn">${ICONS.search}Find matching Spranki cards</button>
    `;

  } else if (!cards || cards.length === 0) {
    bodyHTML = `<div class="spranki-notice">Mapping exists but no cards found.<br><small>Check your Anki tags or note IDs.</small></div>`;

  } else {
    const cardListHTML = cards.map(card => {
      const title = card.front || "Card";
      const displayTitle = title.length > 120 ? title.slice(0, 120) + "…" : title;
      const tagLabel = (card.tags || [])
        .filter(t => t.includes("Spranki"))
        .map(t => t.split("::").slice(-2).join(" · "))
        .slice(0, 1)
        .map(t => `<span class="spranki-tag">${escapeHTML(t)}</span>`)
        .join("");
      const dueBadge = card.dueStatus === "due"
        ? `<span class="spranki-due-badge spranki-due-today">${ICONS.clock}Due today</span>`
        : card.dueStatus === "new"
        ? `<span class="spranki-due-badge spranki-due-new">${ICONS.sparkles}New</span>`
        : "";
      const reviewed = card.tags.includes("sprankiReviewed");
      return `
        <div class="spranki-card">
          <div class="spranki-card-header-row">
            <span class="spranki-linked-badge">${ICONS.check}Linked</span>
            ${dueBadge}
          </div>
          <div class="spranki-card-title">${escapeHTML(displayTitle)}</div>
          <div class="spranki-card-tags">${tagLabel}</div>
          <div class="spranki-card-actions">
            <button class="spranki-btn spranki-open-card" data-note-id="${card.noteId}">${ICONS.externalLink}Open in Anki</button>
            <button class="spranki-btn spranki-secondary spranki-tag-done" data-note-id="${card.noteId}" ${reviewed ? "disabled" : ""}>
              ${reviewed ? `${ICONS.checkCircle}Reviewed` : `${ICONS.bookOpen}Mark Reviewed`}
            </button>
            <button class="spranki-btn spranki-secondary spranki-unlink" data-note-id="${card.noteId}" title="Remove link">${ICONS.x}</button>
          </div>
        </div>`;
    }).join("");
    bodyHTML = cardListHTML + `<button id="spranki-add-link" class="spranki-btn spranki-find-btn" style="margin-top:6px">${ICONS.plusCircle}Link another card</button>`;
  }

  const contributeURL = qid
    ? `https://github.com/spranki-linker/spranki-linker/issues/new?title=Mapping:+${source.name}+Q${qid}`
    : "#";

  const alreadyWrong = lastAnsweredState === qid;
  const sessionBadge = sessionWrongCount > 0
    ? `<button id="spranki-session-btn" class="spranki-session-badge">${ICONS.alertTriangle}${sessionWrongCount} wrong</button>`
    : `<button id="spranki-session-btn" class="spranki-session-badge spranki-session-empty">${ICONS.history}Session</button>`;

  return `
    <div class="spranki-header" style="--source-color: ${source.color}">
      <span class="spranki-logo">Spranki</span>
      <span class="spranki-source">${qid ? `${source.name} Q${qid}` : `${source.name} — waiting…`}</span>
      ${sessionBadge}
      <button id="spranki-toggle" class="spranki-collapse-btn">${ICONS.chevronDown}</button>
    </div>
    <div class="spranki-body">
      ${bodyHTML}
      ${qid ? `
        <div class="spranki-mark-wrong-row">
          <button id="spranki-mark-wrong" class="spranki-btn spranki-secondary" style="font-size:10px;color:#f87171"
            ${alreadyWrong ? "disabled" : ""}>
            ${alreadyWrong ? `${ICONS.xCircle}Marked wrong` : `${ICONS.alertTriangle}Mark question wrong`}
          </button>
        </div>` : ""}
      ${qid ? `<a class="spranki-contribute" href="${contributeURL}" target="_blank">+ Contribute mapping</a>` : ""}
    </div>
  `;
}

// ── Session review panel ──────────────────────────────────────
function showSessionReview(overlay) {
  const body = overlay.querySelector(".spranki-body");
  body.innerHTML = `<div class="spranki-notice spranki-loading"><span class="spranki-spinner"></span>Loading session review…</div>`;

  chrome.runtime.sendMessage({ type: "GET_SESSION_REVIEW", platform: activePlatform }, (response) => {
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
      const groupsHTML = groups.map(g => {
        const label = g.title ? escapeHTML(g.title) : `Q${g.qid}`;
        const cardsHTML = g.cards.length > 0
          ? g.cards.map(c => {
              const front = c.front.length > 100 ? c.front.slice(0, 100) + "…" : c.front;
              const tag = (c.tags || []).filter(t => t.includes("Spranki"))
                .map(t => t.split("::").slice(-2).join(" · ")).slice(0, 1)
                .map(t => `<span class="spranki-tag">${escapeHTML(t)}</span>`).join("");
              return `<div class="spranki-card" style="border-color:rgba(251,146,60,0.3);margin-top:4px">
                <div class="spranki-card-title">${escapeHTML(front)}</div>
                <div class="spranki-card-tags">${tag}</div>
              </div>`;
            }).join("")
          : `<div style="font-size:11px;color:rgba(200,210,240,0.4);padding:4px 0">No linked card yet</div>`;

        return `
          <div style="margin-bottom:8px">
            <div style="font-size:10px;font-weight:700;color:#f87171;margin-bottom:2px;display:flex;align-items:center;gap:4px">${ICONS.xCircle}${label}</div>
            ${cardsHTML}
          </div>`;
      }).join("");

      body.innerHTML = `
        <div style="font-size:11px;color:#f87171;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:4px">${ICONS.alertTriangle}${wrongCount} wrong this session</div>
        ${groupsHTML}
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          ${allNoteIds?.length ? `<button id="spranki-open-session" class="spranki-btn" style="font-size:11px">${ICONS.externalLink}Open all in Anki</button>` : ""}
          <button id="spranki-clear-session" class="spranki-btn spranki-secondary" style="font-size:11px;color:#f87171">${ICONS.trash}Clear &amp; save</button>
          <button id="spranki-show-history" class="spranki-btn spranki-secondary" style="font-size:11px">${ICONS.history}History</button>
          <button id="spranki-session-back" class="spranki-btn spranki-secondary" style="font-size:11px">${ICONS.arrowLeft}Back</button>
        </div>`;
    }

    body.querySelector("#spranki-open-session")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_SESSION_IN_ANKI", noteIds: allNoteIds });
    });

    body.querySelector("#spranki-clear-session")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "CLEAR_SESSION", platform: activePlatform }, () => {
        sessionWrongCount = 0;
        const badge = overlay.querySelector(".spranki-session-badge");
        if (badge) {
          badge.innerHTML = `${ICONS.history}Session`;
          badge.classList.add("spranki-session-empty");
        }
        showSessionReview(overlay);
      });
    });

    body.querySelector("#spranki-show-history")?.addEventListener("click", () => {
      showSessionHistory(overlay);
    });

    body.querySelector("#spranki-session-back")?.addEventListener("click", () => {
      const savedQID = currentQID;
      currentQID = null;
      checkAndRenderOverlay(activePlatform, savedQID, activeTitle, activeQuestion);
    });
  });
}

// ── Session history panel ─────────────────────────────────────
function showSessionHistory(overlay) {
  const body = overlay.querySelector(".spranki-body");
  body.innerHTML = `<div class="spranki-notice spranki-loading"><span class="spranki-spinner"></span>Loading history…</div>`;

  chrome.runtime.sendMessage({ type: "GET_SESSION_HISTORY", platform: activePlatform }, (response) => {
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
      const historyHTML = history.map((entry, i) => {
        const formattedDate = new Date(entry.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        const questionsHTML = entry.questions.map(q =>
          `<div style="font-size:11px;color:rgba(220,220,240,0.6);padding:2px 0 2px 8px;border-left:2px solid rgba(251,146,60,0.3)">
            ${escapeHTML(q.title || `Q${q.qid}`)}
          </div>`
        ).join("");
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
      }).join("");

      body.innerHTML = `
        <div style="font-size:11px;color:rgba(200,210,240,0.6);margin-bottom:6px">Last ${history.length} session${history.length > 1 ? "s" : ""}</div>
        ${historyHTML}
        <button id="spranki-history-back" class="spranki-btn spranki-secondary" style="font-size:11px;margin-top:6px">${ICONS.arrowLeft}Back</button>`;

      // Collapsible entries
      body.querySelectorAll(".spranki-history-entry").forEach(entry => {
        entry.querySelector(".spranki-history-header").addEventListener("click", () => {
          const questions = entry.querySelector(".spranki-history-questions");
          const toggle = entry.querySelector(".spranki-history-toggle");
          const isHidden = questions.style.display === "none";
          questions.style.display = isHidden ? "flex" : "none";
          toggle.innerHTML = isHidden ? ICONS.chevronDown : ICONS.chevronRight;
        });
      });
    }

    body.querySelector("#spranki-history-back")?.addEventListener("click", () => {
      showSessionReview(overlay);
    });
  });
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeDraggable(el) {
  let isDragging = false, startX, startY, origLeft, origTop;
  const header = el.querySelector(".spranki-header");
  header.style.cursor = "grab";

  header.addEventListener("mousedown", e => {
    if (e.target.closest("button")) return; // don't drag when clicking header buttons
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = el.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
  });

  document.addEventListener("mousemove", e => {
    if (!isDragging) return;
    el.style.left = `${origLeft + e.clientX - startX}px`;
    el.style.top = `${origTop + e.clientY - startY}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => { isDragging = false; });
}

init();
