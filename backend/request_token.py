"""Keep the request token across restarts of the same deployment."""
import os
from pathlib import Path
import secrets
import tempfile


def persistent_token(root):
    path = Path(root) / '.request-token'
    if not path.exists():
        descriptor, temporary = tempfile.mkstemp(prefix='.request-token-', dir=root)
        try:
            with os.fdopen(descriptor, 'w', encoding='ascii') as handle:
                handle.write(secrets.token_urlsafe(32))
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            Path(temporary).unlink(missing_ok=True)
    value = path.read_text(encoding='ascii').strip()
    if len(value) != 43 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in value):
        raise ValueError('请求令牌存储格式无效。')
    return value
