import json
import time
import urllib.request

BASE = 'http://127.0.0.1:11434'


def post(path, payload, timeout=300):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def get(path, timeout=60):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


print('--- 1) load chat model qwen3.5:9b (keep_alive 10m) ---')
t0 = time.time()
try:
    r = post('/api/chat', {
        'model': 'qwen3.5:9b',
        'messages': [{'role': 'user', 'content': 'hi'}],
        'stream': False,
        'keep_alive': '10m',
        'options': {'num_predict': 1},
    })
    print(f'  chat ok {time.time()-t0:.1f}s')
except Exception as e:
    print('  chat FAIL', e)

ps = get('/api/ps')
print('  ps:', [(m['name'], round(m.get('size_vram', 0) / 2**30, 1)) for m in ps.get('models', [])])

print('--- 2) now send 6 embedding requests ---')
ok = fail = 0
for i in range(6):
    t0 = time.time()
    try:
        r = post('/api/embed', {
            'model': 'qwen3-embedding:8b',
            'input': ['测试嵌入服务稳定性的一段中文文本。' * 30],
        })
        ok += 1
        print(f'  [{i}] 200 {time.time()-t0:.2f}s')
    except urllib.error.HTTPError as e:
        fail += 1
        print(f'  [{i}] {e.code} {time.time()-t0:.2f}s {e.read().decode("utf-8","replace")[:150]}')
    except Exception as e:
        fail += 1
        print(f'  [{i}] EXC {type(e).__name__}: {e}')
    time.sleep(0.3)

print(f'  embed ok={ok} fail={fail}')

ps = get('/api/ps')
print('--- 3) ps after both ---')
for m in ps.get('models', []):
    print('   ', m['name'], 'vram=%.1f GiB' % (m.get('size_vram', 0) / 2**30))
print('   count =', len(ps.get('models', [])))
