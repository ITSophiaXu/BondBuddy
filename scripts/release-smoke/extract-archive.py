"""Extract a fixed Git archive on Windows without rewriting its file bytes."""

import pathlib
import sys
import tarfile


def safe_member(member, destination):
    name = member.name
    path = pathlib.PurePosixPath(name)
    # Reject drive paths, ADS, backslash traversal and Windows device/alias
    # names too, including when tests are run on a non-Windows host.
    if (not name or path.is_absolute() or pathlib.PureWindowsPath(name).drive
            or "\\" in name or ":" in name or ".." in path.parts
            or any(part.endswith((".", " ")) or pathlib.PureWindowsPath(part).is_reserved()
                   for part in path.parts)):
        raise tarfile.FilterError("Unsafe archive path")
    # Current source and sample Git trees contain regular files/directories.
    # Refuse all links and devices instead of following archive-controlled links.
    if not (member.isfile() or member.isdir()):
        raise tarfile.FilterError("Archive links and special files are refused")
    return tarfile.data_filter(member, destination)


def extract(archive, destination):
    with tarfile.open(archive, mode="r:") as source:
        members = source.getmembers()
        # Validate the entire manifest before writing the first file; retain
        # filtering during extraction to catch pre-existing destination links.
        for member in members:
            safe_member(member, destination)
        source.extractall(destination, members=members, filter=safe_member)


if __name__ == "__main__":
    if sys.version_info < (3, 12) or not hasattr(tarfile, "data_filter"):
        raise SystemExit("Windows archive extraction requires existing Python 3.12+; set BB_RELEASE_TEST_PYTHON")
    if sys.argv[1:] == ["--check"]:
        raise SystemExit(0)
    if len(sys.argv) != 3:
        raise SystemExit("Usage: extract-archive.py ARCHIVE DESTINATION")
    extract(sys.argv[1], sys.argv[2])
