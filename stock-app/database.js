import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'stocks.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT UNIQUE NOT NULL,
    name TEXT,
    data TEXT NOT NULL,
    last_updated TEXT NOT NULL,
    notes TEXT DEFAULT ''
  );
`);

export function saveStock(symbol, name, data) {
  db.prepare(`
    INSERT INTO stocks (symbol, name, data, last_updated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
      name = excluded.name,
      data = excluded.data,
      last_updated = excluded.last_updated
  `).run(symbol.toUpperCase(), name, JSON.stringify(data), new Date().toISOString());
}

export function getStock(symbol) {
  const row = db.prepare('SELECT * FROM stocks WHERE symbol = ?').get(symbol.toUpperCase());
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) };
}

export function getAllStocks() {
  return db.prepare('SELECT id, symbol, name, last_updated, notes FROM stocks ORDER BY last_updated DESC').all();
}

export function deleteStock(symbol) {
  db.prepare('DELETE FROM stocks WHERE symbol = ?').run(symbol.toUpperCase());
}

export function updateNotes(symbol, notes) {
  db.prepare('UPDATE stocks SET notes = ? WHERE symbol = ?').run(notes, symbol.toUpperCase());
}
