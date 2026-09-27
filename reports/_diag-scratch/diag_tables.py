import sqlite3, os, glob

db = os.path.expandvars(r'%APPDATA%\CherryStudio\cherrystudio.sqlite')
print('db path:', db, 'exists:', os.path.exists(db), 'size:', os.path.getsize(db) if os.path.exists(db) else 0)
con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
cur = con.cursor()
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
print('tables:', tables)
