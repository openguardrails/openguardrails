"""Make `gateway` importable when pytest runs from the repository root.

The example is deliberately one file run as `python3 gateway.py`, not an
installed package — the tests import it by putting this directory on sys.path."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
