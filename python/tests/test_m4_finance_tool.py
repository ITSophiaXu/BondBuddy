import copy
import unittest
from bondbuddy_m4_finance_tool import calculate_authorized


class HostAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.source = {"kind":"material", "id":"owned", "project_id":"p", "version":1, "sha256":"a"*64}
        self.host = {"authorized_sources":[self.source]}
        self.request = {"metric":"asset_liability_ratio", "periods":[{
            "period_end":"2025-12-31", "entity_id":"issuer", "scope":"consolidated", "values":{
                key:{"value":value,"unit":"万元","period_end":"2025-12-31","entity_id":"issuer",
                     "scope":"consolidated","uncertain":False,"source":{**self.source,"locator":"表1"}}
                for key,value in (("total_liabilities","5000"),("total_assets","10000"))}}]}

    def test_sources_are_host_owned_and_arithmetic_is_real(self):
        result=calculate_authorized(self.request,self.host)
        self.assertEqual(result["status"],"calculated")
        self.assertEqual(result["periods"][0]["value"],"50")
        self.assertNotIn("authorized_sources",self.request)

    def test_model_cannot_expand_allowlist(self):
        request={**self.request,"authorized_sources":[self.source,{**self.source,"id":"foreign"}]}
        with self.assertRaisesRegex(ValueError,"SOURCE_AUTHORIZATION_CHANGED"):
            calculate_authorized(request,self.host)

    def test_foreign_operand_fails_closed(self):
        request=copy.deepcopy(self.request)
        request["periods"][0]["values"]["total_assets"]["source"]["id"]="foreign"
        result=calculate_authorized(request,self.host)
        self.assertEqual(result["status"],"needs_confirmation")
        self.assertIsNone(result["value"])


if __name__ == "__main__":
    unittest.main()
