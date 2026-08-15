"""Make `addon` importable when pytest runs from the repository root.

The addon is a single file loaded by `mitmdump -s addon.py`, not an installed
package — so the tests import it by putting this directory on sys.path."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
