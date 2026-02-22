CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS vente (
  id UUID PRIMARY KEY,
  montant NUMERIC NOT NULL,
  extensions JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS module_migrations (
  module_name TEXT NOT NULL,
  version INT NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (module_name, version)
);