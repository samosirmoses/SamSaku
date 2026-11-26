"""Export deterministic OpenAPI JSON from the FastAPI app into docs/openapi.json."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT / "backend"
OUTPUT = ROOT / "docs" / "openapi.json"


def export_schema() -> str:
    os.environ.setdefault("SAMSAKU_ENV", "test")
    os.environ.setdefault("DATABASE_URL", "sqlite://")
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    from app.main import app  # noqa: PLC0415

    schema = app.openapi()
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    rendered = export_schema()
    if "--check" in sys.argv:
        if not OUTPUT.is_file():
            print(f"Missing {OUTPUT}. Run: python ops/export_openapi.py")
            return 1
        current = OUTPUT.read_text(encoding="utf-8")
        if current != rendered:
            print(f"{OUTPUT} is out of date with backend OpenAPI schema. Run: python ops/export_openapi.py")
            return 1
        print(f"OK: {OUTPUT} matches backend OpenAPI schema.")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"Wrote {OUTPUT} ({len(rendered)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
