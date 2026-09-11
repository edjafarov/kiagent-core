/* Disposable runtime gate for the scoped plugin driver. Run with Electron's
 * Node runtime; no application profile or repository database is opened. */
const { DatabaseSync } = require('node:sqlite');
if (!DatabaseSync) throw new Error('DatabaseSync unavailable');
const db = new DatabaseSync(':memory:', { readBigInts: true });
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE parent(id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id));');
db.prepare('INSERT INTO parent VALUES (?, ?)').run(1, JSON.stringify({ ok: true }));
if (Number(db.prepare('SELECT json_extract(body, \'$.ok\') AS ok FROM parent').get().ok) !== 1) throw new Error('JSON probe failed');
try { db.prepare('INSERT INTO child VALUES (?)').run(999); throw new Error('foreign-key probe failed'); } catch (e) { if (!String(e.message).includes('FOREIGN KEY')) throw e; }
db.prepare('INSERT INTO parent VALUES (?, ?) RETURNING id').get(2, 'returning');
const seen = db.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3) SELECT max(x) AS x FROM n').get().x;
if (seen !== 3n) throw new Error(`recursive CTE probe failed: ${seen}`);
db.close();
console.log('plugin sqlite compatibility: PASS');
