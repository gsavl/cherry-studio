#!/usr/bin/env python3
"""Read-only MCP bridge for Cherry Studio's Knowledge API."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


SERVER_NAME = "cherry-lan-knowledge"
SERVER_VERSION = "1.0.0"
DEFAULT_API_BASE = "http://192.168.98.13:23333"
DEFAULT_TIMEOUT_SECONDS = 180


TOOLS = [
    {
        "name": "list_knowledge_bases",
        "description": "List the shared Cherry Studio knowledge bases and their IDs.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "search_knowledge",
        "description": (
            "Semantically search the shared Cherry Studio knowledge bases. When a result has a "
            "conceptId, call read_knowledge_document before summarizing the document."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 1000},
                "knowledge_base_ids": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                },
                "knowledge_base_names": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                },
                "document_count": {"type": "integer", "minimum": 1, "maximum": 20, "default": 5},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "read_knowledge_document",
        "description": (
            "Read the indexed text of one knowledge document found by search_knowledge. "
            "Use knowledge_base_id and conceptId from the search result."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "knowledge_base_id": {"type": "string", "minLength": 1},
                "concept_id": {"type": "string", "minLength": 1},
                "char_start": {"type": "integer", "minimum": 0},
                "char_end": {"type": "integer", "minimum": 0},
            },
            "required": ["knowledge_base_id", "concept_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_knowledge_base",
        "description": "Get metadata for one shared Cherry Studio knowledge base by ID.",
        "inputSchema": {
            "type": "object",
            "properties": {"knowledge_base_id": {"type": "string", "minLength": 1}},
            "required": ["knowledge_base_id"],
            "additionalProperties": False,
        },
    },
]


class BridgeError(RuntimeError):
    pass


def _api_base() -> str:
    return os.environ.get("CHERRY_API_BASE", DEFAULT_API_BASE).rstrip("/")


def _api_key() -> str:
    direct = os.environ.get("CHERRY_API_KEY", "").strip()
    if direct:
        return _normalize_key(direct)

    key_path = os.environ.get("CHERRY_API_KEY_FILE", "").strip()
    if not key_path:
        raise BridgeError("CHERRY_API_KEY_FILE or CHERRY_API_KEY is required")

    try:
        return _normalize_key(Path(key_path).expanduser().read_text(encoding="utf-8"))
    except OSError as error:
        raise BridgeError(f"Cannot read Cherry API key file: {error}") from error


def _normalize_key(value: str) -> str:
    key = value.strip()
    if key.startswith("CHERRY_API_KEY="):
        key = key.removeprefix("CHERRY_API_KEY=").strip()
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    if not key:
        raise BridgeError("Cherry API key is empty")
    return key


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(_api_base() + path, data=data, headers=headers, method=method)
    timeout = int(os.environ.get("CHERRY_API_TIMEOUT", str(DEFAULT_TIMEOUT_SECONDS)))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise BridgeError(f"Cherry API returned HTTP {error.code}: {detail[:1000]}") from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise BridgeError(f"Cherry API request failed: {error}") from error


def _list_bases() -> list[dict[str, Any]]:
    payload = _request("GET", "/v1/knowledge-bases?limit=100")
    bases = payload.get("knowledge_bases", [])
    return [
        {
            key: base[key]
            for key in ("id", "name", "description", "embeddingModelId", "createdAt", "updatedAt")
            if key in base
        }
        for base in bases
    ]


def _resolve_base_names(names: list[str]) -> list[str]:
    bases = _list_bases()
    by_name = {str(base.get("name", "")).casefold(): str(base.get("id", "")) for base in bases}
    resolved: list[str] = []
    missing: list[str] = []
    for name in names:
        base_id = by_name.get(name.casefold())
        if base_id:
            resolved.append(base_id)
        else:
            missing.append(name)
    if missing:
        available = ", ".join(sorted(str(base.get("name", "")) for base in bases))
        raise BridgeError(f"Unknown knowledge base name(s): {', '.join(missing)}. Available: {available}")
    return resolved


def _call_tool(name: str, arguments: dict[str, Any]) -> Any:
    if name == "list_knowledge_bases":
        bases = _list_bases()
        return {"knowledge_bases": bases, "total": len(bases)}

    if name == "get_knowledge_base":
        base_id = str(arguments.get("knowledge_base_id", "")).strip()
        if not base_id:
            raise BridgeError("knowledge_base_id is required")
        return _request("GET", f"/v1/knowledge-bases/{urllib.parse.quote(base_id, safe='')}")

    if name == "read_knowledge_document":
        base_id = str(arguments.get("knowledge_base_id", "")).strip()
        concept_id = str(arguments.get("concept_id", "")).strip()
        if not base_id or not concept_id:
            raise BridgeError("knowledge_base_id and concept_id are required")
        body: dict[str, Any] = {"concept_id": concept_id}
        if "char_start" in arguments:
            body["char_start"] = int(arguments["char_start"])
        if "char_end" in arguments:
            body["char_end"] = int(arguments["char_end"])
        return _request(
            "POST",
            f"/v1/knowledge-bases/{urllib.parse.quote(base_id, safe='')}/read",
            body,
        )

    if name == "search_knowledge":
        query = str(arguments.get("query", "")).strip()
        if not query:
            raise BridgeError("query is required")

        ids = [str(value) for value in arguments.get("knowledge_base_ids", [])]
        names = [str(value) for value in arguments.get("knowledge_base_names", [])]
        if names:
            ids.extend(_resolve_base_names(names))
        ids = list(dict.fromkeys(value for value in ids if value))

        count = int(arguments.get("document_count", 5))
        if count < 1 or count > 20:
            raise BridgeError("document_count must be between 1 and 20")

        body: dict[str, Any] = {"query": query, "document_count": count}
        if ids:
            body["knowledge_base_ids"] = ids
        return _request("POST", "/v1/knowledge-bases/search", body)

    raise BridgeError(f"Unknown tool: {name}")


def _tool_result(payload: Any, *, is_error: bool = False) -> dict[str, Any]:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, indent=2)
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _handle(message: dict[str, Any]) -> dict[str, Any] | None:
    request_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}

    if method == "initialize":
        protocol_version = params.get("protocolVersion") or "2024-11-05"
        result = {
            "protocolVersion": protocol_version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        }
    elif method in ("notifications/initialized", "notifications/cancelled"):
        return None
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        try:
            result = _tool_result(_call_tool(str(params.get("name", "")), params.get("arguments") or {}))
        except BridgeError as error:
            result = _tool_result(str(error), is_error=True)
    else:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }

    if request_id is None:
        return None
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def main() -> int:
    for raw_line in sys.stdin.buffer:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line.decode("utf-8"))
            response = _handle(message)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {error}"},
            }
        except Exception as error:
            response = {
                "jsonrpc": "2.0",
                "id": message.get("id") if isinstance(message, dict) else None,
                "error": {"code": -32603, "message": f"Internal error: {error}"},
            }

        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
