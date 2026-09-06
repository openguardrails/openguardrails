import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def senior():
    return json.loads((ROOT / "mandates" / "quant-senior.json").read_text())


@pytest.fixture
def junior():
    return json.loads((ROOT / "mandates" / "quant-junior.json").read_text())
