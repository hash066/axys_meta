CREATE TABLE IF NOT EXISTS video_jobs(
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  tries INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 0,
  lease INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  credits INTEGER NOT NULL,
  charge_ref TEXT,
  output_hash TEXT,
  receipt_json TEXT,
  gpu_ms INTEGER,
  warmup_share_ms INTEGER,
  gpu_measurement TEXT,
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(tenant,content_hash,model_id,model_revision)
);

CREATE INDEX IF NOT EXISTS video_jobs_ready
ON video_jobs(state,available,lease);

CREATE TABLE IF NOT EXISTS video_cache(
  tenant TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  object_path TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(tenant,content_hash,model_id,model_revision)
);
