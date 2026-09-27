import sqlite3

DB = r'C:\Users\alexy\AppData\Roaming\CherryStudio\Data\cherrystudio.sqlite'
con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
cur = con.cursor()

cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%user_model%'")
rows = cur.fetchall()
print('tables:', rows)

try:
    cur.execute('PRAGMA table_info(user_model)')
    cols = [r[1] for r in cur.fetchall()]
    print('cols:', cols)
    sel = ', '.join([c for c in cols if c in ('id', 'name', 'provider', 'context_window', 'max_tokens', 'updated_at')])
    cur.execute(f'SELECT {sel} FROM user_model ORDER BY updated_at DESC LIMIT 40')
    for r in cur.fetchall():
        print(r)
except Exception as e:
    print('ERR', e)
con.close()
