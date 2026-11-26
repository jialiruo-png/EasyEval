-- Give pre-existing previews an execution ID too; a worker must echo it when writing back.
ALTER TABLE draft_previews ADD COLUMN execution_id uuid NOT NULL DEFAULT gen_random_uuid();
