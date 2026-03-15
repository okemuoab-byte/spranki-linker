// ── Shared types across all modules ──────────────────────────

export type Platform = "passMed" | "quesmed" | "pastest" | "onexamination";
export type DueStatus = "due" | "new" | null;

export interface AnkiCard {
  noteId: number;
  front: string;
  tags: string[];
  dueStatus: DueStatus;
}

export interface ScoredCard {
  noteId: number;
  front: string;
  tags: string[];
  score: number;
}

export interface Mapping {
  noteIds?: number[];
  topic?: string;
  tags?: string[];
  search?: string | null;
  contributor?: string;
  autoMapped?: boolean;
}

export interface MappingStore {
  _meta?: Record<string, string>;
  passMed: Record<string, Mapping>;
  quesmed: Record<string, Mapping>;
}

export interface SessionHistoryEntry {
  date: string;
  platform: string;
  wrongCount: number;
  questions: Array<{ qid: string; title: string }>;
}

export interface SessionReviewCard {
  noteId: number;
  front: string;
  tags: string[];
}

export interface SessionReviewGroup {
  qid: string;
  title: string;
  cards: SessionReviewCard[];
}

// ── AnkiConnect raw response types ───────────────────────────

export interface AnkiNoteInfo {
  noteId: number;
  fields: Record<string, { value: string; order: number }>;
  tags: string[];
}

export interface AnkiCardInfo {
  cardId: number;
  note: number;
}

// ── Overlay response (what background returns to content) ─────

export interface OverlayResponse {
  cards?: AnkiCard[];
  error?: string;
  ankiConnectDown?: boolean;
  noQID?: boolean;
  bgError?: string;
  suggestions?: ScoredCard[];
  autoSearching?: boolean;
}

// ── Platform source config (used in content.ts) ───────────────

export interface SourceConfig {
  name: string;
  color: string;
  extractQID: () => string | null;
}
