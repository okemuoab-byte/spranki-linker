-- Spranki Linker — Community Mappings Schema
-- Run this in the Supabase SQL editor for your project.

CREATE TABLE IF NOT EXISTS community_mappings (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  platform        text        NOT NULL,       -- 'passMed' | 'quesmed'
  qid             text        NOT NULL,
  note_id         bigint      NOT NULL,
  topic           text,
  confirmed_count integer     DEFAULT 1,
  created_at      timestamptz DEFAULT now(),
  UNIQUE (platform, qid, note_id)
);

CREATE INDEX IF NOT EXISTS idx_community_mappings_lookup
  ON community_mappings (platform, qid);

-- RLS: public read, anon insert only
ALTER TABLE community_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read"  ON community_mappings FOR SELECT USING (true);
CREATE POLICY "anon insert"  ON community_mappings FOR INSERT WITH CHECK (true);

-- Upsert function: insert new row OR increment confirmed_count on conflict.
-- Called by the extension on every user-confirmed link.
CREATE OR REPLACE FUNCTION upsert_community_mapping(
  p_platform text,
  p_qid      text,
  p_note_id  bigint,
  p_topic    text DEFAULT NULL
) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO community_mappings (platform, qid, note_id, topic)
  VALUES (p_platform, p_qid, p_note_id, p_topic)
  ON CONFLICT (platform, qid, note_id) DO UPDATE SET
    confirmed_count = community_mappings.confirmed_count + 1,
    topic = COALESCE(community_mappings.topic, EXCLUDED.topic);
$$;

-- Allow the anon role to call the function
GRANT EXECUTE ON FUNCTION upsert_community_mapping TO anon;
