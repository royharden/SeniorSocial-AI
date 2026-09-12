CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE service_embeddings (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  content_version text NOT NULL CHECK (content_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'),
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{32}$'),
  embedding vector NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4096 AND vector_dims(embedding) = dimensions),
  embedding_model text NOT NULL CHECK (length(embedding_model) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key !~ E'[\\r\\n\\x00]'),
  reindex_actor text NOT NULL CHECK (reindex_actor = 'system:rag-reindex'),
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, service_id),
  FOREIGN KEY (org_id, service_id) REFERENCES services(org_id, id) ON DELETE CASCADE
);

CREATE INDEX service_embeddings_org_fresh_idx
  ON service_embeddings (org_id, service_id, content_version, content_fingerprint);
CREATE INDEX service_embeddings_vector_1024_hnsw_idx
  ON service_embeddings USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
  WHERE dimensions = 1024;

ALTER TABLE service_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY service_embeddings_org_isolation ON service_embeddings
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON service_embeddings TO seniorsocial_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON service_embeddings FROM seniorsocial_app;
