import sqlite3, os, json

db = os.path.expandvars(r'%APPDATA%\CherryStudio\Data\cherrystudio.sqlite')
con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
cur = con.cursor()

tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
cand = [t for t in tables if 'model' in t.lower() or 'provider' in t.lower()]
print('candidate tables:', cand)

for t in cand:
    cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})").fetchall()]
    print('==', t, cols)
    try:
        rows = cur.execute(f"SELECT * FROM {t}").fetchall()
        for r in rows:
            s = str(r)
            if 'embedding' in s or 'qwen3.5' in s:
                # print compact
                print('  row:', s[:400])
    except Exception as e:
        print('  err', e)
