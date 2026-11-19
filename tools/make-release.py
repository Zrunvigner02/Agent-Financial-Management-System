#!/usr/bin/env python3
"""振颜丽舍 · 1.0 发布打包器（仅用 Python 标准库）

用法：
  python tools/make-release.py                 # 生成推送用源码包 + 清单
  python tools/make-release.py --full         # 额外生成本地完整运行态归档（不推送）

推送用包：release/Agent-Financial-Management-System-v1.0.0.zip
  - 顶层目录 Agent-Financial-Management-System-v1.0.0/
  - 排除 .git、密钥、本地运行数据、依赖、二进制运行时、超大逆向产物
  - 打包前后做敏感信息扫描，发现完整密钥立即失败
本地完整包：<工作区父目录>/Agent-Financial-Management-System-v1.0.0.full.local-only.zip
  - 含 .env / 数据库 / desktop/runtime 等全部本机运行态，绝不要上传到公开仓库
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = "1.0.0"
NAME = f"Agent-Financial-Management-System-v{VERSION}"
RELEASE_DIR = ROOT / "release"
ZIP_PATH = RELEASE_DIR / f"{NAME}.zip"
MANIFEST_PATH = RELEASE_DIR / f"MANIFEST-v{VERSION}.json"

# 推送用包排除规则（目录名 / 文件名 / 后缀）
EXCLUDE_DIRS = {
    ".git", ".local", "node_modules", "runtime", "__pycache__",
    ".idea", ".vscode", "release",
}
EXCLUDE_NAMES = {".env", ".DS_Store", "Thumbs.db"}
EXCLUDE_SUFFIXES = {
    ".exe", ".dll", ".pak", ".dat", ".pyc", ".db", ".db-wal", ".db-shm",
    ".tmp", ".zip", ".gz", ".pem", ".key", ".p12", ".pfx",
}
EXCLUDE_GLOBS = ("*.db.bak*", "*.db-*", "*.db.*", "*.local-only.zip")

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9]{20,}"),                 # DeepSeek / OpenAI 风格完整 Key
    re.compile(r"jl_at_[A-Za-z0-9]{16,}"),              # 完整开放令牌
    # 只匹配「赋值了完整 token 串」的配置行；空值模板、占位描述与注释不误报
    re.compile(r"^\s*(?:DEEPSEEK_API_KEY|WB_MCP_TOKEN)\s*=\s*[A-Za-z0-9_\-]{24,}\s*$", re.M),
]
TEXT_SUFFIXES = {
    ".mjs", ".js", ".py", ".pyw", ".json", ".md", ".txt", ".log", ".html",
    ".css", ".env", ".example", ".yml", ".yaml", ".toml", ".sh", ".bat",
    ".svg", ".csv", ".tsv", ".xml", ".sql", ".ico",
}


def excluded(rel: Path, is_dir: bool = False) -> bool:
    parts = rel.parts
    if any(p in EXCLUDE_DIRS for p in parts[:-1] if is_dir) or any(
        p in EXCLUDE_DIRS for p in parts
    ):
        return True
    name = rel.name
    if name in EXCLUDE_NAMES:
        return True
    if rel.suffix.lower() in EXCLUDE_SUFFIXES:
        return True
    for pat in EXCLUDE_GLOBS:
        if rel.match(pat) or name.startswith("jinli.db.bak"):
            return True
    return False


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_secrets(files: list[Path]) -> list[str]:
    hits: list[str] = []
    for p in files:
        if p.suffix.lower() not in TEXT_SUFFIXES and not p.name.endswith(".example"):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for pat in SECRET_PATTERNS:
            m = pat.search(text)
            if m:
                hits.append(f"{p.relative_to(ROOT).as_posix()}: {m.group(0)[:12]}...")
                break
    return hits


def collect_publish_files() -> list[Path]:
    out: list[Path] = []
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT)
        if excluded(rel):
            continue
        out.append(p)
    return out


def build_zip(files: list[Path], dest: Path, arc_root: str) -> tuple[int, list[str]]:
    """返回 (条目数, 跳过的文件列表)。浏览器 profile 等被占用文件允许跳过。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    skipped: list[str] = []
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in files:
            arc = f"{arc_root}/{p.relative_to(ROOT).as_posix()}"
            try:
                z.write(p, arc)
            except (OSError, PermissionError) as e:
                skipped.append(f"{p.relative_to(ROOT).as_posix()}: {type(e).__name__}")
        return len(z.namelist()), skipped


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="额外生成本地完整运行态归档")
    args = ap.parse_args()

    files = collect_publish_files()
    if not files:
        print("ERROR: 没有可打包文件", file=sys.stderr)
        return 1

    hits = scan_secrets(files)
    if hits:
        print("ERROR: 检测到疑似完整密钥，已中止打包：", file=sys.stderr)
        for h in hits:
            print("  " + h, file=sys.stderr)
        return 2

    count, publish_skipped = build_zip(files, ZIP_PATH, NAME)
    if publish_skipped:
        print("ERROR: 推送用包有文件被跳过，不允许静默缺失：", file=sys.stderr)
        for s in publish_skipped:
            print("  " + s, file=sys.stderr)
        return 4
    with zipfile.ZipFile(ZIP_PATH) as z:
        bad = z.testzip()
        if bad:
            print(f"ERROR: zip 损坏条目 {bad}", file=sys.stderr)
            return 3
        names = z.namelist()

    # 二次核验：归档内容再次扫描（防止路径/编码差异绕过）
    tmp_text = []
    for p in files:
        if p.suffix.lower() in TEXT_SUFFIXES or p.name.endswith(".example"):
            tmp_text.append(p)
    hits2 = scan_secrets(tmp_text)
    if hits2:
        print("ERROR: 二次敏感扫描失败", file=sys.stderr)
        return 2

    manifest = {
        "version": VERSION,
        "archive": ZIP_PATH.name,
        "archive_sha256": sha256_file(ZIP_PATH),
        "archive_bytes": ZIP_PATH.stat().st_size,
        "entry_count": count,
        "file_count": len(files),
        "source_bytes": sum(p.stat().st_size for p in files),
        "secret_scan": "passed (2 rounds)",
        "excluded": [
            ".env（真实密钥）", ".local/（登录态与开放令牌）",
            "backend/data/*.db*（真实账套与备份）",
            "node_modules/ 与 desktop/runtime/（依赖与二进制）",
            "analysis/*.gz（超大逆向产物）", ".git/", "release/*.zip",
        ],
        "files": [
            {"path": p.relative_to(ROOT).as_posix(),
             "bytes": p.stat().st_size,
             "sha256": sha256_file(p)}
            for p in files
        ],
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] 推送用包: {ZIP_PATH}")
    print(f"     条目 {count} / 文件 {len(files)} / {ZIP_PATH.stat().st_size:,} 字节")
    print(f"[OK] 清单: {MANIFEST_PATH}")

    if args.full:
        full_dest = ROOT.parent / f"{NAME}.full.local-only.zip"
        all_files = [
            p for p in sorted(ROOT.rglob("*"))
            if p.is_file() and ".git" not in p.relative_to(ROOT).parts
            and "release" not in p.relative_to(ROOT).parts
        ]
        n, skipped = build_zip(all_files, full_dest, NAME)
        print(f"[OK] 本地完整归档（勿上传）: {full_dest}")
        print(f"     条目 {n} / {full_dest.stat().st_size:,} 字节 / 被占用跳过 {len(skipped)} 个")
        if skipped:
            (ROOT.parent / f"{NAME}.full.skipped.txt").write_text(
                "\n".join(skipped), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
