param(
  [string]$UserData = "$env:APPDATA\CherryStudio",
  [string]$ApiUrl = "http://127.0.0.1:23333",
  [int]$SampleLimit = 10,
  [switch]$AllExtensions
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReportPath = Join-Path $ScriptRoot ("knowledge-index-report-{0}.txt" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

function Find-Python {
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($python) {
    return @{ Exe = $python.Source; PrefixArgs = @() }
  }

  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($py) {
    return @{ Exe = $py.Source; PrefixArgs = @("-3") }
  }

  return $null
}

$Python = Find-Python
if (-not $Python) {
  Write-Host "Python was not found. Please install Python 3 or make python.exe/py.exe available in PATH." -ForegroundColor Red
  exit 1
}

$PythonCode = @'
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sqlite3
import sys
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


SUPPORTED_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".mdx", ".json", ".jsonl", ".csv", ".tsv",
    ".yaml", ".yml", ".xml", ".html", ".htm", ".css", ".scss", ".less",
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".c",
    ".h", ".cpp", ".hpp", ".cs", ".php", ".swift", ".sh", ".bash", ".zsh",
    ".fish", ".ps1", ".bat", ".cmd", ".sql", ".toml", ".ini", ".conf",
    ".cfg", ".log", ".tex", ".rst", ".adoc", ".pdf", ".doc", ".docx",
    ".ppt", ".pptx", ".xls", ".xlsx", ".epub"
}

SKIP_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico",
    ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4", ".mkv", ".mov",
    ".avi", ".wmv", ".zip", ".rar", ".7z", ".tar", ".gz", ".exe", ".dll"
}


def log(lines, message=""):
    print(message)
    lines.append(message)


def norm_path(value):
    if isinstance(value, os.PathLike):
        value = os.fspath(value)
    if not value or not isinstance(value, str):
        return None
    value = value.strip().strip("\"'")
    if not value:
        return None
    if len(value) > 4096:
        return None
    value = value.replace("/", "\\")
    value = re.sub(r"\\+", r"\\", value)
    return os.path.normcase(os.path.abspath(value))


def is_hidden_or_dot(path):
    return any(part.startswith(".") for part in pathlib.Path(path).parts if part not in (".", ".."))


def should_include_file(path, all_extensions=False):
    p = pathlib.Path(path)
    if p.name.startswith(".") or is_hidden_or_dot(path):
        return False
    ext = p.suffix.lower()
    if all_extensions:
        return ext not in SKIP_EXTENSIONS
    return ext in SUPPORTED_EXTENSIONS


def iter_directory_files(directory, all_extensions=False):
    root = pathlib.Path(directory)
    files = []
    if not root.exists():
        return files
    for current_root, dirs, filenames in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for filename in filenames:
            path = pathlib.Path(current_root) / filename
            if should_include_file(path, all_extensions=all_extensions):
                files.append(path)
    return files


def extract_api_key(user_data):
    leveldb = pathlib.Path(user_data) / "Local Storage" / "leveldb"
    if not leveldb.exists():
        return None

    pattern = re.compile(r"cs-sk-[0-9a-fA-F-]{36}")
    for path in leveldb.glob("*"):
        if not path.is_file() or path.name == "LOCK":
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        decode_attempts = []
        decode_attempts.append(raw.decode("utf-8", "ignore"))
        decode_attempts.append(raw.decode("utf-16le", "ignore"))
        if len(raw) > 1:
            decode_attempts.append(raw[1:].decode("utf-16le", "ignore"))

        for text in decode_attempts:
            match = pattern.search(text)
            if match:
                return match.group(0)
    return None


def fetch_knowledge_bases(api_url, api_key):
    if not api_key:
        return None, "API key not found in local storage"
    url = api_url.rstrip("/") + "/v1/knowledge-bases"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + api_key})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return payload.get("knowledge_bases") or [], None
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        return None, f"HTTP {exc.code} from {url}: {body[:300]}"
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def scan_leveldb_for_bases(user_data):
    """Best-effort fallback when the local API is unavailable."""
    leveldb = pathlib.Path(user_data) / "Local Storage" / "leveldb"
    if not leveldb.exists():
        return []

    bases = {}
    id_pattern = re.compile(r'"id"\s*:\s*"([A-Za-z0-9_-]{16,})"')
    name_pattern = re.compile(r'"name"\s*:\s*"([^"]{1,80})"')
    content_pattern = re.compile(r'"content"\s*:\s*"([A-Za-z]:\\\\[^"]+|/[^\"]+)"')

    for path in leveldb.glob("*"):
        if not path.is_file() or path.name == "LOCK":
            continue
        try:
            text = path.read_bytes().decode("utf-16le", "ignore")
        except OSError:
            continue
        if "KnowledgeBase" not in text and "knowledge" not in text:
            continue
        for match in id_pattern.finditer(text):
            base_id = match.group(1)
            if base_id in bases:
                continue
            window = text[match.start(): match.start() + 20000]
            db_file = pathlib.Path(user_data) / "Data" / "KnowledgeBase" / base_id
            if not db_file.exists():
                continue
            name_match = name_pattern.search(window)
            items = []
            for content_match in content_pattern.finditer(window):
                content = content_match.group(1).encode("utf-8").decode("unicode_escape", "ignore")
                if pathlib.Path(content).exists():
                    items.append({"type": "directory", "content": content})
            bases[base_id] = {
                "id": base_id,
                "name": name_match.group(1) if name_match else base_id,
                "items": items,
            }
    return list(bases.values())


def collect_indexed_paths(db_path):
    indexed = set()
    source_count = 0
    if not db_path.exists():
        return indexed, source_count, f"DB file not found: {db_path}"
    try:
        conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
        rows = conn.execute("select source, metadata from vectors").fetchall()
        source_count = len(rows)
        for source, metadata in rows:
            normalized_source = norm_path(source)
            if normalized_source:
                indexed.add(normalized_source)
            if metadata:
                try:
                    meta = json.loads(metadata)
                except Exception:
                    meta = None
                if isinstance(meta, dict):
                    for key in ("source", "originalPath", "path", "filePath"):
                        normalized = norm_path(meta.get(key))
                        if normalized:
                            indexed.add(normalized)
        conn.close()
        return indexed, source_count, None
    except Exception as exc:
        return indexed, source_count, f"{type(exc).__name__}: {exc}"


def relative_display(path, root):
    try:
        return str(pathlib.Path(path).relative_to(root))
    except Exception:
        return str(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-data", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--sample-limit", type=int, default=30)
    parser.add_argument("--all-extensions", action="store_true")
    args = parser.parse_args()

    lines = []
    user_data = pathlib.Path(args.user_data)
    knowledge_dir = user_data / "Data" / "KnowledgeBase"

    log(lines, "Cherry Studio knowledge index check")
    log(lines, "Generated: " + dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    log(lines, "User data: " + str(user_data))
    log(lines, "Knowledge DB dir: " + str(knowledge_dir))
    log(lines, "")

    if not knowledge_dir.exists():
        log(lines, "ERROR: Knowledge DB directory does not exist.")
        pathlib.Path(args.report).write_text("\n".join(lines), encoding="utf-8")
        return 2

    api_key = extract_api_key(user_data)
    bases, api_error = fetch_knowledge_bases(args.api_url, api_key)
    if bases is None:
        log(lines, "WARNING: Could not read knowledge base metadata from local API.")
        log(lines, "Reason: " + str(api_error))
        log(lines, "Trying best-effort local metadata scan...")
        bases = scan_leveldb_for_bases(user_data)
    else:
        log(lines, f"Loaded {len(bases)} knowledge bases from {args.api_url}.")

    if not bases:
        log(lines, "")
        log(lines, "ERROR: No knowledge bases could be loaded.")
        log(lines, "Open Cherry Studio, enable the local API server, then run this script again.")
        pathlib.Path(args.report).write_text("\n".join(lines), encoding="utf-8")
        return 2

    total_missing = 0
    total_expected = 0

    for base in bases:
        base_id = base.get("id")
        base_name = base.get("name") or base_id
        db_path = knowledge_dir / base_id
        indexed_paths, chunk_rows, db_error = collect_indexed_paths(db_path)

        log(lines, "")
        log(lines, "=" * 80)
        log(lines, f"Knowledge base: {base_name} ({base_id})")
        log(lines, f"SQLite rows: {chunk_rows}; indexed path candidates: {len(indexed_paths)}")
        if db_error:
            log(lines, "DB ERROR: " + db_error)
            continue

        directory_items = [item for item in (base.get("items") or []) if item.get("type") == "directory"]
        if not directory_items:
            log(lines, "No directory items found for this base.")
            continue

        for item in directory_items:
            directory = item.get("content")
            log(lines, "")
            log(lines, f"Directory: {directory}")
            if not directory or not pathlib.Path(directory).exists():
                log(lines, "  MISSING DIRECTORY ON DISK")
                continue

            files = iter_directory_files(directory, all_extensions=args.all_extensions)
            expected = {norm_path(path): path for path in files if norm_path(path)}
            missing = [path for normalized, path in expected.items() if normalized not in indexed_paths]
            indexed_count = len(expected) - len(missing)
            total_expected += len(expected)
            total_missing += len(missing)

            log(lines, f"  Files expected: {len(expected)}")
            log(lines, f"  Files indexed:  {indexed_count}")
            log(lines, f"  Files missing:  {len(missing)}")

            if missing:
                by_parent = {}
                for path in missing:
                    parent = str(path.parent)
                    by_parent[parent] = by_parent.get(parent, 0) + 1
                log(lines, f"  Missing by subdirectory (top {args.sample_limit}):")
                for parent, count in sorted(by_parent.items(), key=lambda item: (-item[1], item[0]))[:args.sample_limit]:
                    log(lines, f"    {count:5d}  {parent}")
                if len(by_parent) > args.sample_limit:
                    log(lines, f"    ... {len(by_parent) - args.sample_limit} more subdirectories")

                log(lines, f"  Missing file samples (first {args.sample_limit}):")
                for path in sorted(missing, key=lambda p: str(p).lower())[:args.sample_limit]:
                    log(lines, "    " + relative_display(path, directory))

    log(lines, "")
    log(lines, "=" * 80)
    log(lines, f"Total expected files: {total_expected}")
    log(lines, f"Total missing files:  {total_missing}")
    if total_expected:
        pct = total_missing * 100 / total_expected
        log(lines, f"Missing ratio:        {pct:.2f}%")
    log(lines, "")
    log(lines, "Notes:")
    log(lines, "- This script is read-only. It does not modify Cherry Studio data.")
    log(lines, "- It compares directory files with source/originalPath metadata in the vector SQLite DB.")
    log(lines, "- If the local API is unavailable, metadata detection is best-effort and may miss directories.")

    report = pathlib.Path(args.report)
    report.write_text("\n".join(lines), encoding="utf-8")
    log(lines, "Report written to: " + str(report))
    return 1 if total_missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
'@

$ArgsForPython = @(
  "--user-data", $UserData,
  "--api-url", $ApiUrl,
  "--report", $ReportPath,
  "--sample-limit", "$SampleLimit"
)

if ($AllExtensions) {
  $ArgsForPython += "--all-extensions"
}

Write-Host "Running Cherry Studio knowledge index check..." -ForegroundColor Cyan
Write-Host "User data: $UserData"
Write-Host "Report: $ReportPath"
Write-Host ""

$TempPythonPath = Join-Path $env:TEMP ("check-cherry-knowledge-index-{0}.py" -f ([guid]::NewGuid().ToString("N")))
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($TempPythonPath, $PythonCode, $Utf8NoBom)

try {
  & $Python.Exe @($Python.PrefixArgs + @($TempPythonPath) + $ArgsForPython)
  $ExitCode = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $TempPythonPath -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Report saved to: $ReportPath" -ForegroundColor Green
exit $ExitCode
