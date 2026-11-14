CREATE TABLE IF NOT EXISTS game_run_accounts (
  account_id text PRIMARY KEY,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object')
);
