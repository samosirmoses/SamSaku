"""Ensure Living Spec documentation and exported OpenAPI contract stay strictly synced with code."""
import json
from pathlib import Path

from app.main import app

REPO_ROOT = Path(__file__).resolve().parents[2]
REQUIRED_DOCS = [
    REPO_ROOT / "README.md",
    REPO_ROOT / "SPEC.md",
    REPO_ROOT / "AGENTS.md",
    REPO_ROOT / "docs" / "ARCHITECTURE.md",
    REPO_ROOT / "docs" / "DATABASE.md",
    REPO_ROOT / "docs" / "API.md",
    REPO_ROOT / "docs" / "VPS_DEPLOYMENT.md",
    REPO_ROOT / "docs" / "CHANGELOG.md",
    REPO_ROOT / "docs" / "openapi.json",
]


def test_required_living_docs_exist():
    missing = [str(p.relative_to(REPO_ROOT)) for p in REQUIRED_DOCS if not p.is_file()]
    assert not missing, f"Dokumentasi wajib tidak ditemukan: {missing}"


def test_openapi_snapshot_is_in_sync():
    openapi_path = REPO_ROOT / "docs" / "openapi.json"
    expected = json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    actual = openapi_path.read_text(encoding="utf-8")
    assert actual == expected, (
        "docs/openapi.json tidak sinkron dengan endpoint/schema FastAPI saat ini. "
        "Jalankan `python ops/export_openapi.py` dan perbarui docs/API.md serta SPEC.md."
    )
