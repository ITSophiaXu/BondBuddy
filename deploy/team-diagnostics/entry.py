#!/usr/bin/python3 -I
"""Fixed root entry; installed directory is administrator-owned and non-writable."""
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import canonical, load_config


def main(args):
    os.umask(0o077)
    if os.geteuid() != 0: raise ValueError('Privileged broker required')
    config = load_config()
    if args and args[0] == '--collect':
        # A sudo diagnostic identity cannot call this administrative write path.
        if os.environ.get('SUDO_USER') in config['actors']: raise ValueError('Collection is administrator-only')
        if args not in (['--collect'], ['--collect', '--require-synced']): raise ValueError('Invalid collector arguments')
        from collector import collect
        return collect(config, require_synced='--require-synced' in args)
    from broker import dispatch
    actor = os.environ.get('SUDO_USER', '')
    return dispatch(config, actor, args, stdin=sys.stdin.buffer)


if __name__ == '__main__':
    try:
        print(canonical(main(sys.argv[1:])))
    except Exception as error:
        # Do not echo provider exception text or user-controlled secrets.
        print(canonical({'error': 'DIAGNOSTIC_REQUEST_FAILED', 'type': type(error).__name__}), file=sys.stderr)
        sys.exit(2)
