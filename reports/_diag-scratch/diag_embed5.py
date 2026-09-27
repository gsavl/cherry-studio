import json
import time
import urllib.request

URL = 'http://127.0.0.1:11434/api/embed'
payload = {
    'model': 'qwen3-embedding:8b',
    'input': ['这是一段用于测试嵌入服务稳定性的中文文本，重复若干次以增加长度。' * 20],
    'options': {'num_ctx': 8192},
}

ok = 0
fail = 0
for i in range(8):
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode('utf-8', 'replace')
            ok += 1
            print(f'[{i}] 200  {time.time()-t0:.2f}s  len={len(body)}')
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        fail += 1
        print(f'[{i}] {e.code}  {time.time()-t0:.2f}s  BODY={body[:600]}')
    except Exception as e:
        fail += 1
        print(f'[{i}] EXC {type(e).__name__}: {e}')
    time.sleep(0.3)

print(f'\n=== ok={ok} fail={fail} ===')
