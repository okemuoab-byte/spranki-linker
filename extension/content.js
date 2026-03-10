// ============================================================
// Spranki Linker - Content Script
// Detects PassMed / Quesmed question pages and shows Anki card overlay
// ============================================================

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
    sessionWrongCount = ((stored.sessionWrong || {})[platform] || []).length;
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
            chrome.runtime.sendMessage({ type: "RECORD_WRONG", platform, qid }, (res) => {
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
    }, 500);
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
    chrome.runtime.sendMessage({ type: "RECORD_WRONG", platform: activePlatform, qid: currentQID }, (res) => {
      sessionWrongCount = res?.count ?? sessionWrongCount;
      btn.textContent = "✗ Marked wrong";
      btn.disabled = true;
      lastAnsweredState = currentQID;
      // Update badge
      const badge = overlay.querySelector(".spranki-session-badge");
      if (badge) badge.textContent = `${sessionWrongCount} wrong`;
    });
  });

  // Collapse toggle
  overlay.querySelector("#spranki-toggle")?.addEventListener("click", () => {
    const body = overlay.querySelector(".spranki-body");
    const isHidden = body.style.display === "none";
    body.style.display = isHidden ? "block" : "none";
    overlay.querySelector("#spranki-toggle").textContent = isHidden ? "▼" : "▶";
  });

  // Open card in Anki browser
  overlay.querySelectorAll(".spranki-open-card").forEach(btn => {
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_IN_ANKI", noteId: btn.dataset.noteId });
    });
  });

  // Mark card done in Anki
  overlay.querySelectorAll(".spranki-tag-done").forEach(btn => {
    btn.addEventListener("click", () => {
      const tag = `${activePlatform}::done`;
      chrome.runtime.sendMessage({ type: "TAG_CARD", noteId: btn.dataset.noteId, tag });
      btn.textContent = "✓ Tagged";
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
      body.innerHTML = `<div class="spranki-notice">⚠️ Could not read question text.<br><small>Right-click the question → Inspect, then tell us the element class.</small></div>`;
      return;
    }

    body.innerHTML = `<div class="spranki-notice spranki-loading">🔍 Searching your Spranki deck…</div>`;

    chrome.runtime.sendMessage(
      { type: "GET_SUGGESTIONS", questionText },
      (response) => {
        if (chrome.runtime.lastError) {
          body.innerHTML = `<div class="spranki-notice">⚠️ ${escapeHTML(chrome.runtime.lastError.message)}</div>`;
          return;
        }
        // Re-render the whole overlay with suggestions
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
    bodyHTML = `<div class="spranki-notice spranki-loading">🔍 Searching your Spranki deck…</div>`;

  } else if (noQID) {
    const path = window.location.pathname + window.location.search;
    bodyHTML = `<div class="spranki-notice">⏳ Waiting for a question.<br><small>${escapeHTML(path)}</small></div>`;

  } else if (bgError) {
    bodyHTML = `<div class="spranki-notice">⚠️ Extension error.<br><small>${escapeHTML(bgError)}</small></div>`;

  } else if (ankiConnectDown) {
    bodyHTML = `<div class="spranki-notice">⚠️ AnkiConnect not running.<br><small>Open Anki with the AnkiConnect add-on installed.</small></div>`;

  } else if (suggestions) {
    // Auto-suggest results — exclude cards already linked to this question
    const filtered = suggestions.filter(c => !excludeNoteIds.has(c.noteId));
    if (filtered.length === 0) {
      bodyHTML = `<div class="spranki-notice">No other matches found in your deck.</div>`;
    } else {
      bodyHTML = filtered.map(card => `
        <div class="spranki-suggestion">
          <div class="spranki-card-title">${escapeHTML(card.front.slice(0, 130))}${card.front.length > 130 ? "…" : ""}</div>
          <div class="spranki-suggestion-meta">
            <span class="spranki-score">${Math.round(card.score * 100)}% match</span>
            <span class="spranki-card-tags">${card.tags.slice(0, 2).map(t => `<span class="spranki-tag">${escapeHTML(t.split("::").pop())}</span>`).join("")}</span>
          </div>
          <div class="spranki-card-actions">
            <button class="spranki-btn spranki-open-card" data-note-id="${card.noteId}">Preview</button>
            <button class="spranki-btn spranki-link-card" data-note-id="${card.noteId}" data-topic="${escapeHTML(card.front.slice(0, 80))}">Link this ✓</button>
          </div>
        </div>
      `).join("");
    }

  } else if (error) {
    // No mapping — show the auto-suggest trigger
    bodyHTML = `
      <div class="spranki-notice">No mapping yet for Q${qid}.<br><small>Link one from your deck or contribute on GitHub.</small></div>
      <button id="spranki-find-matches" class="spranki-btn spranki-find-btn">🔍 Find matching Spranki cards</button>
    `;

  } else if (!cards || cards.length === 0) {
    bodyHTML = `<div class="spranki-notice">Mapping exists but no cards found.<br><small>Check your Anki tags or note IDs.</small></div>`;

  } else {
    const cardListHTML = cards.map(card => {
      const title = card.front || "Card";
      const displayTitle = title.length > 120 ? title.slice(0, 120) + "…" : title;
      // Show only the 2 deepest tag segments: "Keratitis · Microbial"
      const tagLabel = (card.tags || [])
        .filter(t => t.includes("Spranki"))
        .map(t => t.split("::").slice(-2).join(" · "))
        .slice(0, 1)
        .map(t => `<span class="spranki-tag">${escapeHTML(t)}</span>`)
        .join("");
      return `
        <div class="spranki-card">
          <div class="spranki-linked-badge">✓ Linked</div>
          <div class="spranki-card-title">${escapeHTML(displayTitle)}</div>
          <div class="spranki-card-tags">${tagLabel}</div>
          <div class="spranki-card-actions">
            <button class="spranki-btn spranki-open-card" data-note-id="${card.noteId}">Open in Anki</button>
            <button class="spranki-btn spranki-secondary spranki-tag-done" data-note-id="${card.noteId}">Mark Done</button>
            <button class="spranki-btn spranki-secondary spranki-unlink" data-note-id="${card.noteId}" style="color:#f87171" title="Remove link">×</button>
          </div>
        </div>`;
    }).join("");
    bodyHTML = cardListHTML + `<button id="spranki-add-link" class="spranki-btn spranki-find-btn" style="margin-top:6px">🔗 Link another card</button>`;
  }

  const contributeURL = qid
    ? `https://github.com/spranki-linker/spranki-linker/issues/new?title=Mapping:+${source.name}+Q${qid}`
    : "#";

  const sessionBadge = sessionWrongCount > 0
    ? `<button id="spranki-session-btn" class="spranki-session-badge">${sessionWrongCount} wrong</button>`
    : `<button id="spranki-session-btn" class="spranki-session-badge spranki-session-empty">Session</button>`;

  return `
    <div class="spranki-header" style="--source-color: ${source.color}">
      <span class="spranki-logo">🃏 Spranki</span>
      <span class="spranki-source">${qid ? `${source.name} Q${qid}` : `${source.name} — waiting…`}</span>
      ${sessionBadge}
      <button id="spranki-toggle" class="spranki-collapse-btn">▼</button>
    </div>
    <div class="spranki-body">
      ${bodyHTML}
      ${qid ? `
        <div class="spranki-mark-wrong-row">
          <button id="spranki-mark-wrong" class="spranki-btn spranki-secondary" style="font-size:10px;color:#f87171"
            ${lastAnsweredState === qid ? "disabled" : ""}>
            ${lastAnsweredState === qid ? "✗ Marked wrong" : "✗ Mark question wrong"}
          </button>
        </div>` : ""}
      ${qid ? `<a class="spranki-contribute" href="${contributeURL}" target="_blank">+ Contribute mapping</a>` : ""}
    </div>
  `;
}

// ── Session review panel ──────────────────────────────────────
function showSessionReview(overlay) {
  const body = overlay.querySelector(".spranki-body");
  body.innerHTML = `<div class="spranki-notice spranki-loading">Loading session review…</div>`;

  chrome.runtime.sendMessage({ type: "GET_SESSION_REVIEW", platform: activePlatform }, (response) => {
    if (chrome.runtime.lastError || !response) {
      body.innerHTML = `<div class="spranki-notice">⚠️ Could not load session data.</div>`;
      return;
    }

    const { wrongCount, cards, allNoteIds, ankiConnectDown } = response;

    if (wrongCount === 0) {
      body.innerHTML = `
        <div class="spranki-notice">No wrong answers recorded yet.<br><small>Answer some questions or use "Mark question wrong".</small></div>
        <button id="spranki-session-back" class="spranki-btn spranki-secondary" style="font-size:11px">← Back</button>`;
    } else if (ankiConnectDown) {
      body.innerHTML = `
        <div class="spranki-notice">⚠️ AnkiConnect not running.<br><small>${wrongCount} wrong questions tracked.</small></div>
        <button id="spranki-session-back" class="spranki-btn spranki-secondary" style="font-size:11px">← Back</button>`;
    } else {
      const cardList = cards.length > 0
        ? cards.map(c => {
            const title = c.front.length > 100 ? c.front.slice(0, 100) + "…" : c.front;
            const tag = (c.tags || []).filter(t => t.includes("Spranki"))
              .map(t => t.split("::").slice(-2).join(" · ")).slice(0, 1)
              .map(t => `<span class="spranki-tag">${escapeHTML(t)}</span>`).join("");
            return `<div class="spranki-card" style="border-color:rgba(251,146,60,0.3)">
              <div class="spranki-card-title">${escapeHTML(title)}</div>
              <div class="spranki-card-tags">${tag}</div>
            </div>`;
          }).join("")
        : `<div class="spranki-notice" style="padding:8px">Cards not yet linked to those questions.</div>`;

      body.innerHTML = `
        <div style="font-size:11px;color:#f87171;font-weight:700;margin-bottom:4px">✗ ${wrongCount} wrong this session</div>
        ${cardList}
        <div style="display:flex;gap:6px;margin-top:6px">
          ${allNoteIds?.length ? `<button id="spranki-open-session" class="spranki-btn" style="font-size:11px">Open all in Anki</button>` : ""}
          <button id="spranki-clear-session" class="spranki-btn spranki-secondary" style="font-size:11px;color:#f87171">Clear session</button>
          <button id="spranki-session-back" class="spranki-btn spranki-secondary" style="font-size:11px">← Back</button>
        </div>`;
    }

    // Wire up buttons
    body.querySelector("#spranki-open-session")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_SESSION_IN_ANKI", noteIds: allNoteIds });
    });

    body.querySelector("#spranki-clear-session")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "CLEAR_SESSION" }, () => {
        sessionWrongCount = 0;
        const badge = overlay.querySelector(".spranki-session-badge");
        if (badge) {
          badge.textContent = "Session";
          badge.classList.add("spranki-session-empty");
        }
        showSessionReview(overlay); // refresh
      });
    });

    body.querySelector("#spranki-session-back")?.addEventListener("click", () => {
      // Force re-render by clearing currentQID first (guard skips if qid === currentQID)
      const savedQID = currentQID;
      currentQID = null;
      checkAndRenderOverlay(activePlatform, savedQID, activeTitle, activeQuestion);
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
