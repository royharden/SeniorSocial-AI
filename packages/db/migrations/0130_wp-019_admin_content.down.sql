DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS faqs;
DROP TABLE IF EXISTS content_pages;
DROP TABLE IF EXISTS admin_mutations;
DROP FUNCTION IF EXISTS protect_admin_mutation_update();
ALTER TABLE partners DROP COLUMN IF EXISTS admin_version;
ALTER TABLE users DROP COLUMN IF EXISTS admin_version;
