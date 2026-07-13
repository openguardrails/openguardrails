"""mitmproxy entrypoint — load with:  mitmdump -s run.py

Loads the OGRGateway addon as a proper package so its intra-package imports
(`from . import protocols`) resolve. Pointing `-s` at ogr_mitmproxy/addon.py
directly would break those relative imports.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ogr_mitmproxy.addon import addons  # noqa: E402,F401  (mitmproxy reads `addons`)
