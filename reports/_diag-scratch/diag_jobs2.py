import sqlite3, os

db = os.path.expandvars(r'%APPDATA%\CherryStudio\Data\cherrystudio.sqlite')
con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
cur = con.cursor()

print('=== failed jobs (latest 12) ===')
try:
    rows = cur.execute(
        "SELECT id, type, status, error, created_at, updated_at FROM job "
        "WHERE status='failed' ORDER BY updated_at DESC LIMIT 12"
    ).fetchall()
except Exception as e:
    print('job table error:', e)
    tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    print('tables:', tables)
    rows = []
for r in rows:
    print(r[0], '|', r[1], '|', r[2])
    print('   error:', str(r[3])[:300])
    print('   created:', r[4], 'updated:', r[5])
