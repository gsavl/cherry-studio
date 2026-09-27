import json, urllib.request, urllib.error, subprocess

# identify models
out = subprocess.run(['ollama', 'list'], capture_output=True, text=True).stdout
print('=== ollama list ===')
print(out)

out = subprocess.run(['ollama', 'ps'], capture_output=True, text=True).stdout
print('=== ollama ps ===')
print(out)

# try an embed request and capture full error body
print('=== embed test ===')
for i in range(6):
    req = urllib.request.Request(
        'http://127.0.0.1:11434/api/embed',
        data=json.dumps({'model': 'qwen3-embedding:8b', 'input': '测试句子 test sentence %d' % i}).encode(),
        headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read())
            print(i, 'OK dims=', len(body['embeddings'][0]))
    except urllib.error.HTTPError as e:
        print(i, 'HTTP', e.code, 'body:', e.read().decode()[:400])
    except Exception as e:
        print(i, 'ERR', type(e).__name__, str(e)[:200])
