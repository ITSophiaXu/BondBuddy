"""Synthetic broker tests: no Docker, database or production Blob calls."""
import base64
import json
import unittest
from unittest import mock
import broker
from common import DiagnosticFailure, failure_details

class ContentDeadlineTests(unittest.TestCase):
    def read(self, kind, command_result=b'payload', command_error=None, offset=0, length=4):
        ref={'kind':kind,'sha256':'a'*64,'owner_user_id':'owner','project_id':'project','run_id':'run','attempt_id':'attempt'}
        database=mock.Mock();database.content_ref.return_value=ref
        helper=mock.Mock();helper.read_bytes.return_value=b'synthetic-helper'
        options={'kind':kind,'id':'attempt','offset':offset,'length':length}
        with mock.patch.object(broker,'discover',return_value=[{'service':'api','state':'running','stream':'synthetic-api'}]),mock.patch.object(broker,'trusted_file',return_value=helper),mock.patch.object(broker,'command',return_value=command_result,side_effect=command_error) as command:
            result=broker.read_content({},options,database)
        database.content_ref.assert_called_once_with(kind,'attempt')
        return result,command

    def test_exec_outer_deadline_exceeds_120_second_helper_deadline(self):
        result,command=self.read('exec')
        self.assertEqual(command.call_args.kwargs['timeout'],135)
        self.assertEqual(command.call_args.kwargs['max_bytes'],21*1024*1024)
        self.assertEqual(command.call_args.kwargs['input_bytes'],b'synthetic-helper')
        self.assertEqual(base64.b64decode(result['data']),b'payl')

    def test_prompt_and_result_keep_existing_outer_deadline(self):
        for kind in ['prompt','result']:
            with self.subTest(kind=kind):
                _,command=self.read(kind)
                self.assertEqual(command.call_args.kwargs['timeout'],45)

    def test_exec_helper_timeout_maps_only_to_fixed_public_classification(self):
        with self.assertRaises(DiagnosticFailure) as raised:
            self.read('exec',command_error=DiagnosticFailure('container_read','COMMAND_EXIT',3))
        self.assertEqual(failure_details(raised.exception),{'stage':'container_read','code':'CONTENT_READ_TIMEOUT','exit_status':3})
        self.assertEqual(str(raised.exception),'Diagnostic operation failed')

    def test_other_command_errors_and_nonexec_exit3_are_not_reclassified(self):
        for kind,stage,code,status in [('exec','container_read','COMMAND_EXIT',2),('exec','container_read','COMMAND_TIMEOUT',None),('exec','local_command','COMMAND_EXIT',3),('prompt','container_read','COMMAND_EXIT',3),('result','container_read','COMMAND_EXIT',3)]:
            with self.subTest(kind=kind,stage=stage,code=code,status=status):
                error=DiagnosticFailure(stage,code,status)
                with self.assertRaises(DiagnosticFailure) as raised:self.read(kind,command_error=error)
                self.assertIs(raised.exception,error)

    def test_broker_still_scrubs_all_bytes_before_utf8_byte_paging(self):
        text='synthetic 中文 authorization=Bearer-synthetic-token\n'
        clean=broker.scrub(text).encode()
        output=[]
        for offset in range(0,len(clean),4):
            result,_=self.read('exec',command_result=text.encode(),offset=offset)
            output.append(base64.b64decode(result['data']))
        self.assertEqual(b''.join(output),clean)
        self.assertNotIn(b'Bearer-synthetic-token',b''.join(output))

    def test_invalid_content_reference_is_rejected_before_helper(self):
        database=mock.Mock();database.content_ref.side_effect=ValueError('Content missing, deleted or purged')
        with mock.patch.object(broker,'command') as command,self.assertRaises(ValueError):
            broker.read_content({}, {'kind':'exec','id':'attempt','offset':0,'length':4},database)
        command.assert_not_called()

if __name__=='__main__':unittest.main()
