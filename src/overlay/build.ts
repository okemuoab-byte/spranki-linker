import { ICONS } from "../utils/icons";
import { escapeHTML } from "../utils/html";
import type { OverlayResponse, SourceConfig } from "../types";

export function buildOverlayHTML(
  response: OverlayResponse,
  source: SourceConfig,
  qid: string | null,
  excludeNoteIds: Set<number> = new Set(),
  sessionWrongCount = 0,
  lastAnsweredQID: string | null = null
): string {
  const {
    cards,
    error,
    ankiConnectDown,
    noQID,
    bgError,
    suggestions,
    autoSearching,
  } = response || {};

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
    const filtered = suggestions.filter((c) => !excludeNoteIds.has(c.noteId));
    if (filtered.length === 0) {
      bodyHTML = `
        <div class="spranki-notice">${ICONS.search} No matching card found in your Spranki deck for this topic.<br><small>This question may not have a linked card yet.</small></div>`;
    } else {
      bodyHTML = filtered
        .map(
          (card) => `
        <div class="spranki-suggestion">
          <div class="spranki-card-title">${escapeHTML(card.front.slice(0, 130))}${card.front.length > 130 ? "…" : ""}</div>
          <div class="spranki-suggestion-meta">
            <span class="spranki-score">${Math.round(card.score * 100)}% match</span>
            <span class="spranki-card-tags">${card.tags
              .slice(0, 2)
              .map(
                (t) =>
                  `<span class="spranki-tag">${escapeHTML(t.split("::").pop() ?? t)}</span>`
              )
              .join("")}</span>
          </div>
          <div class="spranki-card-actions">
            <button class="spranki-btn spranki-open-card" data-note-id="${card.noteId}">${ICONS.externalLink}Preview</button>
            <button class="spranki-btn spranki-link-card" data-note-id="${card.noteId}" data-topic="${escapeHTML(card.front.slice(0, 80))}">${ICONS.link}Link</button>
          </div>
        </div>`
        )
        .join("");
    }
  } else if (error) {
    bodyHTML = `
      <div class="spranki-notice">${ICONS.search} No mapping yet for Q${qid}.<br><small>Link a card from your deck below.</small></div>
      <button id="spranki-find-matches" class="spranki-btn spranki-find-btn">${ICONS.search}Find matching Spranki cards</button>
    `;
  } else if (!cards || cards.length === 0) {
    bodyHTML = `<div class="spranki-notice">Mapping exists but no cards found.<br><small>Check your Anki tags or note IDs.</small></div>`;
  } else {
    const cardListHTML = cards
      .map((card) => {
        const title = card.front || "Card";
        const displayTitle = title.length > 120 ? title.slice(0, 120) + "…" : title;
        const tagLabel = (card.tags || [])
          .filter((t) => t.includes("Spranki"))
          .map((t) => t.split("::").slice(-2).join(" · "))
          .slice(0, 1)
          .map((t) => `<span class="spranki-tag">${escapeHTML(t)}</span>`)
          .join("");
        const dueBadge =
          card.dueStatus === "due"
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
      })
      .join("");
    bodyHTML =
      cardListHTML +
      `<button id="spranki-add-link" class="spranki-btn spranki-find-btn" style="margin-top:6px">${ICONS.plusCircle}Link another card</button>`;
  }

  const alreadyWrong = lastAnsweredQID === qid;
  const sessionBadge =
    sessionWrongCount > 0
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
      ${
        qid
          ? `
        <div class="spranki-mark-wrong-row">
          <button id="spranki-mark-wrong" class="spranki-btn spranki-secondary" style="font-size:10px;color:#f87171"
            ${alreadyWrong ? "disabled" : ""}>
            ${alreadyWrong ? `${ICONS.xCircle}Marked wrong` : `${ICONS.alertTriangle}Mark question wrong`}
          </button>
        </div>`
          : ""
      }
      ${
        qid
          ? `<a class="spranki-contribute" href="https://github.com/okemuoab-byte/spranki-linker/issues/new?title=Mapping:+${source.name}+Q${qid}" target="_blank">+ Contribute mapping</a>`
          : ""
      }
    </div>
  `;
}
