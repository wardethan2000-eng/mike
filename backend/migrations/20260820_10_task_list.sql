-- The job list a chat is working to.
--
-- Per chat, not per matter: a firm-wide matter workplan is a different feature
-- with its own permissions questions. Kept on the chat rather than in memory so
-- it survives a backend restart, a pause, and a follow-up message the next day.

alter table public.chats
  add column if not exists task_list jsonb,
  add column if not exists task_list_updated_at timestamptz;
