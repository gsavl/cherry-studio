import sqlite3, os

db = os.path.expandvars(r'%APPDATA%\CherryStudio\Data\cherrystudio.sqlite')
con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
cur = con.cursor()

print('=== user_model: ollama / qwen3.5 rows ===')
for r in cur.execute(
    "SELECT id, model_id, context_window, max_input_tokens, max_output_tokens, updated_at "
    "FROM user_model WHERE provider_id='ollama' ORDER BY updated_at DESC LIMIT 12"
).fetchall():
    print(' ', r)

print()
print('=== knowledge_base embedding config ===')
cols = [c[1] for c in cur.execute("PRAGMA table_info(knowledge_base)").fetchall()]
print('columns:', cols)
for r in cur.execute("SELECT * FROM knowledge_base").fetchall():
    print(' ', str(r)[:400])
