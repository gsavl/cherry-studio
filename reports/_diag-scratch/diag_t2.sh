#!/bin/bash
BASE="http://127.0.0.1:11434"
CURL="curl -s --noproxy '*' --max-time 300"

echo "=== 1) embed x6 (serial) ==="
ok=0; fail=0
for i in 1 2 3 4 5 6; do
  code=$($CURL -o /tmp/e_$i.json -w '%{http_code}' -X POST "$BASE/api/embed" \
    -H 'Content-Type: application/json' \
    -d '{"model":"qwen3-embedding:8b","input":["测试嵌入服务稳定性的一段中文文本内容，重复多次以增加长度。"]}')
  if [ "$code" = "200" ]; then ok=$((ok+1)); else fail=$((fail+1)); echo "  [$i] HTTP $code $(head -c 160 /tmp/e_$i.json)"; fi
done
echo "  embed ok=$ok fail=$fail"

echo "=== 2) ps after embed ==="
$CURL "$BASE/api/ps" | head -c 500
echo

echo "=== 3) chat with num_ctx=32768 ==="
$CURL -o /tmp/c1.json -w '  chat HTTP %{http_code}\n' -X POST "$BASE/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.5:9b","messages":[{"role":"user","content":"hi"}],"stream":false,"keep_alive":"10m","options":{"num_ctx":32768,"num_predict":1}}'
head -c 200 /tmp/c1.json
echo

echo "=== 4) ps after chat (expect 2 models) ==="
$CURL "$BASE/api/ps" | head -c 700
echo

echo "=== 5) embed x6 again while chat loaded ==="
ok2=0; fail2=0
for i in 1 2 3 4 5 6; do
  code=$($CURL -o /tmp/f_$i.json -w '%{http_code}' -X POST "$BASE/api/embed" \
    -H 'Content-Type: application/json' \
    -d '{"model":"qwen3-embedding:8b","input":["测试嵌入服务稳定性的一段中文文本内容，重复多次以增加长度。"]}')
  if [ "$code" = "200" ]; then ok2=$((ok2+1)); else fail2=$((fail2+1)); echo "  [$i] HTTP $code $(head -c 160 /tmp/f_$i.json)"; fi
done
echo "  embed(while chat loaded) ok=$ok2 fail=$fail2"
