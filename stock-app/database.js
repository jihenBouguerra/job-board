const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'stocks.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT UNIQUE NOT NULL,
    name TEXT,
    data TEXT NOT NULL,
    last_updated TEXT NOT NULL,
    notes TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    added_at TEXT NOT NULL,
    UNIQUE(symbol)
  );
`);

module.exports = {
  saveStock(symbol, name, data) {
    const stmt = db.prepare(`
      INSERT INTO stocks (symbol, name, data, last_updated)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        name = excluded.name,
        data = excluded.data,
        last_updated = excluded.last_updated
    `);
    stmt.run(symbol.toUpperCase(), name, JSON.stringify(data), new Date().toISOString());
  },

  getStock(symbol) {
    const row = db.prepare('SELECT * FROM stocks WHERE symbol = ?').get(symbol.toUpperCase());
    if (!row) return null;
    return { ...row, data: JSON.parse(row.data) };
  },

  getAllStocks() {
    const rows = db.prepare('SELECT id, symbol, name, last_updated, notes FROM stocks ORDER BY last_updated DESC').all();
    return rows;
  },

  deleteStock(symbol) {
    db.prepare('DELETE FROM stocks WHERE symbol = ?').run(symbol.toUpperCase());
  },

  updateNotes(symbol, notes) {
    db.prepare('UPDATE stocks SET notes = ? WHERE symbol = ?').run(notes, symbol.toUpperCase());
  },

  isStored(symbol) {
    const row = db.prepare('SELECT symbol FROM stocks WHERE symbol = ?').get(symbol.toUpperCase());
    return !!row;
  }
};
