"""Prepare a bounded accepted-revision copy while retaining the original bytes."""
from pathlib import Path
import sys
from bondbuddy_file_authoring.check import clean


def effective_source(source: Path, destination: Path):
    if source.resolve() == destination.resolve():
        raise ValueError('SOURCE_OUTPUT_SAME_PATH')
    if source.suffix.lower() != '.docx' or destination.suffix.lower() != '.docx':
        raise ValueError('SOURCE_DOCX_REQUIRED')
    clean(source, destination)


if __name__ == '__main__':
    effective_source(Path(sys.argv[1]), Path(sys.argv[2]))
