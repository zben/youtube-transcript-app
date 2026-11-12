-- Initial schema, mirroring src/db.ts exactly (D1 is SQLite, so DDL is shared).
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  youtube_id TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transcripts (
  video_id TEXT PRIMARY KEY,
  plain_text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE TABLE IF NOT EXISTS summaries (
  video_id TEXT PRIMARY KEY,
  summary_markdown TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE TABLE IF NOT EXISTS chapter_5w1h (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  chapter_heading TEXT NOT NULL,
  who TEXT NOT NULL,
  what TEXT NOT NULL,
  when_time TEXT NOT NULL,
  where_place TEXT NOT NULL,
  why TEXT NOT NULL,
  how TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(video_id, chapter_heading),
  FOREIGN KEY (video_id) REFERENCES videos(id)
);
