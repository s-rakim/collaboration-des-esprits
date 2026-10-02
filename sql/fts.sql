CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body, author, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ins AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body, author) VALUES (new.id, new.body, new.author);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_del AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, author)
    VALUES ('delete', old.id, old.body, old.author);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_upd AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, author)
    VALUES ('delete', old.id, old.body, old.author);
  INSERT INTO messages_fts(rowid, body, author) VALUES (new.id, new.body, new.author);
END;
