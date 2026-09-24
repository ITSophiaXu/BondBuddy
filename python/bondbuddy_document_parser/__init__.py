"""Versioned document parsing boundary for BondBuddy workers."""

from .parser import PARSER_VERSION, parse_request

__all__ = ["PARSER_VERSION", "parse_request"]
