DROP TABLE IF EXISTS partners;
DROP TABLE IF EXISTS service_categories;
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS orgs;
DROP FUNCTION IF EXISTS set_updated_at();
DROP TYPE IF EXISTS user_role;
DROP TYPE IF EXISTS account_state;
DROP TYPE IF EXISTS display_mode;
DROP TYPE IF EXISTS locale;

-- Extensions and the runtime role are cluster/database infrastructure shared by
-- later packages. Down removes every WP-003 object and grant attached to those
-- objects, but deliberately does not drop shared prerequisites.
