"""Synthetic local SSH client deadline tests; SSH is always mocked."""
import base64
import hashlib
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock
import export as exporter

class ExportDeadlineTests(unittest.TestCase):
    def invoke(self,query):
        content=query.startswith('content ') or query.startswith('exec-log ')
        body=b'synthetic bytes'
        page={'offset':0,'encoding':'base64','redacted_sha256':hashlib.sha256(body).hexdigest(),'data':base64.b64encode(body).decode(),'next_offset':None,'capture_truncated':True} if content else {'items':[],'next_cursor':None}
        response=mock.Mock(stdout=json.dumps(page).encode())
        with tempfile.TemporaryDirectory() as directory,mock.patch.object(exporter.subprocess,'run',return_value=response) as run:
            output=pathlib.Path(directory)/'export.log'
            result=exporter.export('synthetic-target','synthetic-config',query,output)
            self.assertTrue(result['complete'])
            self.assertFalse(output.with_name(output.name+'.partial').exists())
            if content:self.assertEqual(output.read_bytes(),body);self.assertTrue(result['source_capture_truncated'])
        args=run.call_args.args[0]
        self.assertIn('StrictHostKeyChecking=yes',args)
        self.assertIn('BatchMode=yes',args)
        self.assertEqual(args[-2],'synthetic-target')
        return run.call_args.kwargs

    def test_content_exec_client_deadline_exceeds_broker_135_seconds(self):
        self.assertEqual(self.invoke('content exec attempt --reason debug')['timeout'],180)

    def test_exec_log_alias_has_the_same_180_second_deadline(self):
        self.assertEqual(self.invoke('exec-log attempt --reason debug')['timeout'],180)

    def test_all_other_queries_keep_the_existing_60_second_deadline(self):
        for query in ['content prompt snapshot --reason debug','content result result --reason debug','logs api','db attempts','runs succeeded']:
            with self.subTest(query=query):self.assertEqual(self.invoke(query)['timeout'],60)

    def test_exec_timeout_keeps_partial_and_never_claims_complete(self):
        with tempfile.TemporaryDirectory() as directory,mock.patch.object(exporter.subprocess,'run',side_effect=subprocess.TimeoutExpired('synthetic-ssh',180)):
            output=pathlib.Path(directory)/'export.log'
            with self.assertRaises(subprocess.TimeoutExpired):exporter.export('synthetic-target','synthetic-config','exec-log attempt --reason debug',output)
            self.assertFalse(output.exists());self.assertTrue(output.with_name(output.name+'.partial').exists())

if __name__=='__main__':unittest.main()
