"""Compatibility entry point for the design preview tools."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from bondbuddy_template_redaction import *
