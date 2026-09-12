DROP TRIGGER IF EXISTS moderation_human_guard ON moderation_items;
DROP FUNCTION IF EXISTS enforce_human_moderation_decision();
DROP TABLE IF EXISTS moderation_items;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS forum_replies;
DROP TABLE IF EXISTS forum_posts;
DROP TABLE IF EXISTS forum_topics;
