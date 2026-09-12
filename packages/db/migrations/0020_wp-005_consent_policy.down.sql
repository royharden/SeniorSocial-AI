DROP TABLE IF EXISTS policy_decisions;
DROP TABLE IF EXISTS consent_scopes;
DROP FUNCTION IF EXISTS enforce_consent_scope_history();
DROP TABLE IF EXISTS consent_grants;
DROP TABLE IF EXISTS caregiver_links;
DROP FUNCTION IF EXISTS enforce_caregiver_link_version();
DROP TYPE IF EXISTS consent_scope_name;
