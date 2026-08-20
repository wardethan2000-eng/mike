-- Which model wrote an answer. Without this there is no way to tell whether a
-- badly formatted or thin answer came from one model rather than another, which
-- is exactly the question asked when an answer disappoints.
alter table chat_messages add column if not exists model text;
alter table word_chat_messages add column if not exists model text;
notify pgrst, 'reload schema';
