-- Off-chain token metadata ("reference" JSON per NEP-148) that near.fm hosts
-- for coins launched from songs on launchpads that keep description and links
-- off chain (JustHoot). The URL and sha256 go into the token's ft_metadata.
CREATE TABLE IF NOT EXISTS coin_references (
    hash        TEXT PRIMARY KEY,                       -- sha256 of body, hex
    body        TEXT NOT NULL,                          -- the exact bytes served
    song_id     INTEGER REFERENCES songs(id) ON DELETE SET NULL,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
