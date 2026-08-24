"""sys.path for the src/ layout — the repo's convention for a src-layout package
tested from the root pytest run (CI installs nothing but pytest itself)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
