import sqlite3, os, datetime

db = os.path.expandvars(r'%APPDATA%\CherryStudio\Data\cherrystudio.sqlite')
con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
cur = con.cursor()

print('=== failed jobs (latest 10) ===')
rows = cur.execute(
    "SELECT id, type, status, error, created_at, updated_at FROM job "
    "WHERE status='failed' ORDER BY updated_at DESC LIMIT 10"
).fetchall()
for r in rows:
    created = datetime.datetime.fromtimestamp(r[4]/1000).strftime('%H:%M:%S')
    updated = datetime.datetime.fromtimestamp(r[5]/1000).strftime('%H:%M:%S')
    print(r[0], '| created', created, '| updated', updated)
    print('   error:', str(r[3])[:300])

print()
print('=== knowledge_item failed count ===')
try:
    cnt = cur.execute("SELECT processing_status, COUNT(*) FROM knowledge_item GROUP BY processing_status").fetchall()
    for r in cnt:
        print(r)
except Exception as e:
    cols = [c[1] for c in cur.execute("PRAGMA table_info(knowledge_item)").fetchall()]
    print('columns:', cols)
    for c in ('status', 'indexing_status'):
        if c in cols:
            print(c, cur.execute(f"SELECT {c}, COUNT(*) FROM knowledge_item GROUP BY {c}").fetchall())
