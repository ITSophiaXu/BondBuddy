import unittest
from types import SimpleNamespace
from backend.server import Handler

class EsaOriginTests(unittest.TestCase):
    def valid(self, host, origin, scheme='https'):
        request = SimpleNamespace(server=SimpleNamespace(server_port=8000),
            app=SimpleNamespace(allowed_hosts={'bonddraftai-openclaw.japaneast.cloudapp.azure.com','bonddraft.gululai.com'}),
            headers={'Host':host,'Origin':origin}, request_scheme=lambda:scheme)
        return Handler.valid_origin(request)

    def test_esa_origin_with_azure_upstream_host(self):
        self.assertTrue(self.valid('bonddraftai-openclaw.japaneast.cloudapp.azure.com','https://bonddraft.gululai.com'))
        self.assertTrue(self.valid('bonddraft.gululai.com','https://bonddraft.gululai.com'))
        self.assertTrue(self.valid('bonddraftai-openclaw.japaneast.cloudapp.azure.com','https://bonddraftai-openclaw.japaneast.cloudapp.azure.com'))

    def test_untrusted_hosts_and_origins_remain_blocked(self):
        self.assertFalse(self.valid('evil.example','https://bonddraft.gululai.com'))
        for origin in ['https://evil.example','https://bonddraft.gululai.com.evil.example','http://bonddraft.gululai.com','https://user@bonddraft.gululai.com','https://bonddraft.gululai.com/path','null']:
            with self.subTest(origin=origin):
                self.assertFalse(self.valid('bonddraftai-openclaw.japaneast.cloudapp.azure.com',origin))
