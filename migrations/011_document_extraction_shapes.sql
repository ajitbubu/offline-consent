-- 011_document_extraction_shapes.sql
-- Corrects the recorded shape of the two extraction columns.
--
-- No schema change. The columns and the training-export index have been in
-- place since 008; what was missing was anything that WROTE them, and the
-- documented token shape turned out not to survive contact with a real scan.
--
-- Two things were wrong with `[{text, bbox, confidence}]`:
--
--   1. No page. evidence_object accepts application/pdf, so a multi-page scan is
--      a supported input the flat shape cannot describe at all.
--   2. No coordinate space. A bbox is pixels in *some* raster, and nothing
--      recorded which - not the render DPI, not the page dimensions. A blob
--      stored today would have been unusable the moment the renderer's default
--      changed.
--
-- Rather than add geometry columns to evidence_object that only this one reader
-- would ever use, the blob is now self-describing: page dimensions travel with
-- the tokens that are expressed in them.

COMMENT ON COLUMN intake_draft.ocr_tokens IS
  'Word-level OCR output, self-describing so a bbox is meaningful without any other row: '
  '{schemaVersion, engine, engineVersion, capturedAt, pages: [{page, width, height, '
  'tokens: [{text, bbox: [x0,y0,x1,y1], confidence}]}]}. Pixel space is the page raster, '
  'top-left origin. Retained on committed drafts because the pair (tokens, human-verified '
  'payload) IS the training set for the extraction model - the review screen doubles as the '
  'annotation tool, so every correction improves the next one. Written by '
  'POST /api/staff/extract via src/lib/extraction.ts.';

COMMENT ON COLUMN intake_draft.extraction IS
  'What the extraction service PROPOSED, kept beside the payload a human confirmed: '
  '{schemaVersion, engine, engineVersion, extractedAt, tickboxes: [{purposeId, granted, '
  'confidence, anchorScore, inkRatio, page, bbox}]}. granted is null when the printed label '
  'could not be located, which is not the same as "found the box and it is empty". Never read '
  'by commitDraft(): only payload is committed, and a value moves from here into payload '
  'solely by a reviewer accepting it. The difference between the two is how extraction '
  'quality is measured.';

-- The service is told nothing it could use to name a purpose (PRD SEC-9): labels
-- go over the wire as an ordered list and come back by index, and src/lib/extraction.ts
-- maps index onto purpose_id against the rows it sent.
COMMENT ON COLUMN consent_notice_purpose.printed_label IS
  'The exact wording printed beside this tick-box on this form version. Doubles as the '
  'anchor for tick-box extraction: the service fuzzy-matches it against the OCR token '
  'stream and reads ink density beside the match, which is why tick-box reading needs no '
  'training data while text extraction does. Its trigram index serves both that match and '
  'the reviewer''s search.';
