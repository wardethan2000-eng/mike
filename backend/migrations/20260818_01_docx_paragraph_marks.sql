-- Migration date: 2026-08-18

-- Migration: an edit can now add or remove whole paragraphs, not just text
-- inside one. A new paragraph carries its own tracked paragraph mark
-- (<w:pPr><w:rPr><w:ins/></w:rPr></w:pPr>), and a deleted paragraph carries a
-- matching <w:del>. Accept/Reject has to resolve those marks together with the
-- run-level change, so their w:ids are stored here.
--
-- They are kept out of del_w_id / ins_w_id on purpose: the frontend matches
-- those two against the <ins>/<del> elements the preview renders, and
-- paragraph marks do not produce any.

ALTER TABLE public.document_edits
  ADD COLUMN IF NOT EXISTS mark_w_ids text[] NOT NULL DEFAULT '{}'::text[];
