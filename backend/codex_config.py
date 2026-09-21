"""Keep model credentials separate from the isolated worker's tool policy."""
from __future__ import annotations

import json
import os
import tempfile
import tomllib
from pathlib import Path


def read_config(home):
    path = Path(home) / 'config.toml'
    try:
        return tomllib.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    except (ValueError, OSError):
        # TOML/parser errors must not expose a line containing a credential.
        raise ValueError('无法读取 Codex 配置，请检查 config.toml 的格式与权限。') from None


def full_access_enabled(environment=None):
    """Honor the owner's explicit container Codex configuration."""
    env = os.environ if environment is None else environment
    home = env.get('BOND_CODEX_HOME') or env.get('CODEX_HOME')
    return bool(home and read_config(home).get('sandbox_mode') == 'danger-full-access')


def write_worker_config(home):
    """Retain only model/provider settings; never inherit MCP, hooks or tools."""
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True)
    config = read_config(home)
    lines = ['cli_auth_credentials_store = "file"', 'web_search = "disabled"']
    full_access = config.get('sandbox_mode') == 'danger-full-access'
    if full_access:
        lines += ['sandbox_mode = "danger-full-access"', 'approval_policy = "never"']
    for key in ('model', 'model_provider', 'model_reasoning_effort',
                'model_catalog_json', 'forced_login_method'):
        if isinstance(config.get(key), str):
            lines.append(f'{key} = {json.dumps(config[key], ensure_ascii=False)}')
    selected = config.get('model_provider')
    providers = config.get('model_providers', {})
    provider = providers.get(selected, {}) if isinstance(providers, dict) and isinstance(selected, str) else {}
    if isinstance(provider, dict) and provider:
        lines += ['', f'[model_providers.{json.dumps(selected, ensure_ascii=False)}]']
        for key, kind in (
            ('name', str), ('base_url', str), ('wire_api', str),
            ('env_key', str), ('experimental_bearer_token', str),
            ('requires_openai_auth', bool), ('supports_websockets', bool),
        ):
            if isinstance(provider.get(key), kind):
                lines.append(f'{key} = {json.dumps(provider[key], ensure_ascii=False)}')
    tools = 'true' if full_access else 'false'
    lines += ['', '[features]', f'shell_tool = {tools}', f'view_image = {tools}']
    if full_access:
        lines.append('use_legacy_landlock = false')
    lines.append('')
    descriptor, temporary = tempfile.mkstemp(prefix='.config-', suffix='.toml', dir=home)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write('\n'.join(lines))
        os.chmod(temporary, 0o600)
        os.replace(temporary, home / 'config.toml')
    finally:
        Path(temporary).unlink(missing_ok=True)


def deepseek_status(env):
    """Local credential readiness; a successful real request verifies API access."""
    home = env.get('CODEX_HOME') or str(Path.home() / '.codex')
    config = read_config(home)
    selected = env.get('BOND_CODEX_PROVIDER') or config.get('model_provider')
    if selected != 'deepseek':
        return None
    providers = config.get('model_providers', {})
    provider = providers.get('deepseek', {}) if isinstance(providers, dict) else {}
    if not isinstance(provider, dict):
        provider = {}
    base_url = provider.get('base_url', '')
    configured = (
        provider.get('wire_api') == 'responses'
        and provider.get('requires_openai_auth') is False
        and isinstance(base_url, str)
        and base_url.rstrip('/') in ('https://api.deepseek.com', 'https://api.deepseek.com/v1')
    )
    env_key = provider.get('env_key')
    credential = env.get(env_key, '') if isinstance(env_key, str) else ''
    credential = credential or provider.get('experimental_bearer_token', '')
    ready = bool(configured and isinstance(credential, str) and credential.strip())
    return {
        'installed': True, 'ready': ready, 'provider': 'deepseek',
        'model': env.get('BOND_CODEX_MODEL') or config.get('model', 'deepseek-flash'),
        'configuration_resolved': bool(env.get('CODEX_HOME')),
        'message': ('DeepSeek 已配置；连接与任务执行能力将在实际运行时验证。' if ready
                    else 'DeepSeek 配置或 API 密钥缺失，请检查当前服务的 Codex 配置。'),
    }
