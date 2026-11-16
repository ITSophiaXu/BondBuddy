import base64
import contextlib
import io
import json
import pathlib
import tempfile
import time
import unittest
from unittest import mock

import archive
import broker
import collector
import common
import console
import database
import export as exporter

STAMP = '2026-11-16T00:00:00.000000001Z'


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.tmp.name)/'archive.sqlite3'
        self.db = archive.connect(self.path, write=True)
    def tearDown(self):
        self.db.close(); self.tmp.cleanup()
    def add(self, n, start=0):
        with self.db:
            for i in range(start, start+n):
                archive.record(self.db,'main','a'*64,'api',STAMP,i,'line '+str(i))
    def test_paginate_every_same_timestamp_record_and_freeze_ceiling(self):
        self.add(1205)
        first = archive.page(self.db,{},100)
        self.add(3,1205)
        seen = first['items']; cursor=first['next_cursor']
        while cursor:
            part=archive.page(self.db,{},100,cursor); seen += part['items']; cursor=part['next_cursor']
        self.assertEqual(len(seen),1205)
        self.assertEqual(len({x['id'] for x in seen}),1205)
        self.assertEqual(len(archive.page(self.db,{},1000)['items']),1000)
    def test_cursor_cannot_change_source_or_inject_sql(self):
        self.add(3); cur=archive.page(self.db,{},1)['next_cursor']
        with self.assertRaises(ValueError): archive.page(self.db,{'source':'other'},1,cur)
        with self.assertRaises(ValueError): archive.page(self.db,{'service':"x' OR 1=1"})
        with self.assertRaises(ValueError): archive.page(self.db,{},cursor='bad@')
    def test_no_seven_day_history_limit(self):
        with self.db: archive.record(self.db,'main','a'*64,'api','2020-01-01T00:00:00Z',1,'old retained evidence')
        self.assertEqual(len(archive.page(self.db,{'from':'2019-01-01T00:00:00Z'})['items']),1)
    def test_readonly_connection_rejects_writes(self):
        read=archive.connect(self.path)
        try:
            with self.assertRaises(Exception): read.execute('DELETE FROM records')
        finally: read.close()
    def test_same_timestamp_replay_and_bounded_resume_do_not_drop_duplicates(self):
        lines=[(STAMP+' identical\n').encode() for _ in range(250)]
        cfg={'node':'main'}; item={'stream':'b'*64,'service':'authoring'}
        for _ in range(30):
            partial=collector.consume_lines(self.db,cfg,item,iter(lines),max_bytes=1000)
            if not partial: break
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0],250)
        collector.consume_lines(self.db,cfg,item,iter(lines))
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0],250)
    def test_incomplete_capture_rolls_back_checkpoint_and_rows(self):
        def broken():
            yield (STAMP+' first\n').encode()
            raise RuntimeError('source disconnected')
        with self.assertRaises(RuntimeError): collector.consume_lines(self.db,{'node':'main'},{'stream':'b'*64,'service':'api'},broken())
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0],0)
        self.assertIsNone(archive.checkpoint(self.db,'docker:'+'b'*64))
    def test_long_line_is_reported_instead_of_silent_truncation(self):
        with self.assertRaises(ValueError): collector.consume_lines(self.db,{'node':'main'},{'stream':'b'*64,'service':'api'},[(STAMP+' x').encode()])
    def test_multiline_private_key_stays_redacted_across_capture_batches(self):
        lines=[(STAMP+' '+value+'\n').encode() for value in ['-----BEGIN PRIVATE KEY-----','sensitive-base64-key-line','-----END PRIVATE KEY-----','normal log']]
        cfg={'node':'main'}; item={'stream':'b'*64,'service':'api'}
        for _ in range(5):
            if not collector.consume_lines(self.db,cfg,item,iter(lines),max_bytes=1): break
        messages=[x['message'] for x in archive.page(self.db,{})['items']]
        self.assertEqual(messages,['[private key redacted]']*3+['normal log'])
    def test_legacy_tail_is_last_records_and_still_pageable(self):
        self.add(20)
        first=archive.page(self.db,{'tail':5},2)
        self.assertEqual([x['ordinal'] for x in first['items']],[15,16])
        second=archive.page(self.db,{'tail':5},10,first['next_cursor'])
        self.assertEqual([x['ordinal'] for x in second['items']],[17,18,19])
    def test_relative_time_window_is_frozen_across_pages(self):
        self.add(4)
        with mock.patch.object(archive,'since_timestamp',return_value='2020-01-01T00:00:00.000000000Z'):
            first=archive.page(self.db,{'since':'1d'},2)
        with mock.patch.object(archive,'since_timestamp',side_effect=AssertionError('must not recompute')):
            second=archive.page(self.db,{'since':'1d'},2,first['next_cursor'])
        self.assertEqual(len(second['items']),2)
    def test_large_records_are_bounded_by_bytes_and_continue(self):
        with self.db:
            for i in range(8): archive.record(self.db,'main','a'*64,'api',STAMP,i,'x'*(900*1024))
        first=archive.page(self.db,{},1000)
        self.assertEqual(len(first['items']),4)
        second=archive.page(self.db,{},1000,first['next_cursor'])
        self.assertEqual(len(second['items']),4)
    def test_central_backlog_remains_visible_with_fresh_heartbeat(self):
        self.add(3); batch=archive.export_batch(self.db,'main',0,1)
        batch['status']={'checked_at':time.time(),'last_sequence':3}
        other=archive.connect(pathlib.Path(self.tmp.name)/'central.sqlite3',True)
        try:
            archive.ingest(other,'main',batch)
            state=broker.sources({'node':'main'},other)['items'][0]
            self.assertFalse(state['stale']); self.assertEqual(state['pending_records'],2)
        finally: other.close()
    def test_expired_logs_do_not_reappear_on_replay_and_unsent_logs_are_retained(self):
        self.add(3); batch=archive.export_batch(self.db,'main',0)
        self.assertEqual(archive.prune(self.db,'2027-01-01T00:00:00Z','main',1),1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM records').fetchone()[0],2)
        central=archive.connect(pathlib.Path(self.tmp.name)/'central.sqlite3',True)
        try:
            archive.ingest(central,'main',batch)
            archive.prune(central,'2027-01-01T00:00:00Z','hub',0)
            archive.ingest(central,'main',batch)
            self.assertEqual(central.execute('SELECT count(*) FROM records').fetchone()[0],0)
            bad=json.loads(json.dumps(batch));bad['records'][0]['message']='tampered expired message'
            with self.assertRaises(ValueError): archive.ingest(central,'main',bad)
        finally: central.close()
    def test_central_ingest_is_idempotent_and_source_bound(self):
        self.add(3); batch=archive.export_batch(self.db,'main',0)
        other=archive.connect(pathlib.Path(self.tmp.name)/'central.sqlite3',True)
        try:
            self.assertEqual(archive.ingest(other,'main',batch)['acknowledged'],3)
            self.assertEqual(archive.ingest(other,'main',batch)['acknowledged'],3)
            self.assertEqual(other.execute('SELECT count(*) FROM records').fetchone()[0],3)
            with self.assertRaises(ValueError): archive.ingest(other,'main',{**batch,'source':'impersonated'})
            bad=json.loads(json.dumps(batch)); bad['records'][1]['message']='different'
            with self.assertRaises(ValueError): archive.ingest(other,'main',bad)
            self.assertEqual(other.execute('SELECT count(*) FROM records').fetchone()[0],3)
        finally: other.close()
    def test_missing_batch_predecessor_cannot_be_acknowledged(self):
        self.add(5); batch=archive.export_batch(self.db,'main',3)
        other=archive.connect(pathlib.Path(self.tmp.name)/'central.sqlite3',True)
        try:
            with self.assertRaises(ValueError): archive.ingest(other,'main',batch)
        finally: other.close()
    def test_lost_ack_retries_without_duplicates_or_lost_records(self):
        self.add(25); central=archive.connect(pathlib.Path(self.tmp.name)/'central.sqlite3',True)
        lost=[True]
        def send(config,op,payload):
            reply=archive.ingest(central,'main',json.loads(payload))
            if lost[0]: lost[0]=False; raise TimeoutError()
            return json.dumps(reply).encode()
        try:
            with self.assertRaises(TimeoutError): collector.sync(self.db,{'node':'main'},send)
            self.assertEqual(archive.checkpoint(self.db,'uploaded',0),0)
            self.assertTrue(collector.sync(self.db,{'node':'main'},send))
            self.assertEqual(central.execute('SELECT count(*) FROM records').fetchone()[0],25)
        finally: central.close()
    def test_missing_and_stale_sources_are_visible(self):
        with self.db: self.db.execute('INSERT INTO source_status VALUES(?,?)',('main',json.dumps({'checked_at':1})))
        result=broker.sources({'node':'main','expected_sources':['main','azure']},self.db)
        self.assertTrue(next(x for x in result['items'] if x['source']=='azure')['missing'])
        self.assertTrue(all(x['stale'] for x in result['items']))
    def test_terminal_controls_and_credentials_removed_before_archive(self):
        with self.db: archive.record(self.db,'main','a'*64,'api',STAMP,1,'\x1b[2J password=sample-secret Bearer sampleToken')
        text=archive.page(self.db,{})['items'][0]['message']
        self.assertNotIn('\x1b',text); self.assertNotIn('sample-secret',text); self.assertNotIn('sampleToken',text)


class SecurityTests(unittest.TestCase):
    def test_discovery_follows_projects_across_rename_scale_and_stopped_containers(self):
        rows=[('a'*64,'new-parser','bb-execution','worker-parse','running'),
              ('b'*64,'new-confirm','bb-execution','upload-confirmation','running'),
              ('c'*64,'old-worker','bb-execution','worker','exited'),
              ('d'*64,'other','unrelated','api','running'),
              ('e'*64,'bb-main-looking-but-untrusted','unrelated','worker','running'),
              ('f'*64,'bb-elastic-execution-egress','','','running')]
        run=mock.Mock(return_value=('\n'.join('\t'.join(x) for x in rows)).encode())
        result=collector.discover({'compose_projects':['bb-execution'],'explicit_containers':['bb-elastic-execution-egress']},run)
        self.assertEqual(len(result),4); self.assertIn('exited',[x['state'] for x in result])
        self.assertNotIn('Config.Env',' '.join(run.call_args.args[0]))
    def test_reader_cannot_ingest_or_run_administrative_commands(self):
        config={'actors':{'dev':'reader'},'state_directory':'/not-used'}
        with mock.patch.object(broker,'audit') as audit:
            for args in [['ingest'],['--collect'],['sh'],['docker','exec','x','sh'],['db','users','--id',"x';select 1--"],['logs','api',';','id']]:
                with self.subTest(args=args), self.assertRaises(ValueError): broker.dispatch(config,'dev',args)
            audit.assert_not_called()
    def test_ingest_identity_cannot_read_other_sources(self):
        with mock.patch.object(broker,'audit') as audit, self.assertRaises(ValueError):
            broker.dispatch({'actors':{'machine':'ingest'}},'machine',['logs'])
        audit.assert_not_called()
    def test_failed_audit_blocks_data_access(self):
        with mock.patch.object(broker,'audit',side_effect=OSError()),mock.patch.object(broker,'Database') as db,self.assertRaises(OSError):
            broker.dispatch({'actors':{'dev':'reader'}},'dev',['content','prompt','p','--reason','debug'])
        db.assert_not_called()
    def test_content_requires_reason_and_valid_bounds(self):
        for args in [['content','prompt','x'],['content','prompt','../secret','--reason','debug'],['content','exec','x','--reason','debug','--offset','-1'],['exec-log','x','--all'],['content','exec','x','--reason','debug','--length','99999999']]:
            with self.subTest(args=args), self.assertRaises(ValueError): broker.parse(args)
        self.assertEqual(broker.parse(['content','prompt','x','--reason','debug'])['kind'],'prompt')
    def test_console_never_dispatches_arbitrary_shell(self):
        with mock.patch.object(console.subprocess,'call') as call:
            for text in ['bash -c id','cat /etc/shadow','scp -t /tmp/x','internal-sftp','logs api\nsh']:
                with self.assertRaises(ValueError): console.execute(text)
            call.assert_not_called()
            console.execute('logs api ; touch /tmp/x')
            self.assertEqual(call.call_args.args[0][-5:],['logs','api',';','touch','/tmp/x'])
            self.assertNotIn('shell',call.call_args.kwargs)
    def test_redaction_preserves_usage_counts_and_stack_context(self):
        result=common.scrub({'input_tokens':42,'output_tokens':7,'access_token':'secret','message':'at parseFile(line=4) api_key=SECRET'})
        self.assertEqual(result['input_tokens'],42); self.assertEqual(result['output_tokens'],7)
        self.assertEqual(result['access_token'],'[redacted]'); self.assertIn('parseFile',result['message']); self.assertNotIn('SECRET',result['message'])
    def test_database_parser_rejects_injection_before_io(self):
        db=database.Database({})
        with mock.patch.object(db,'query') as query:
            for filters in [{'run':"a';DROP TABLE x;--"},{'state':'x\n'}, {'other':'1'}]:
                with self.assertRaises(ValueError): db.page('jobs',filters)
            query.assert_not_called()
    def test_symlink_and_world_writable_config_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'config'; path.write_text('{}'); path.chmod(0o666)
            with self.assertRaises(ValueError): common.trusted_file(path)
    def test_schema_grants_views_only_and_does_not_inherit_secret_columns(self):
        sql=database.install_sql()
        self.assertNotIn('GRANT SELECT ON ALL TABLES IN SCHEMA public',sql)
        self.assertNotIn('password_hash',sql)
        self.assertIn('NOBYPASSRLS',sql)
        self.assertIn('security_barrier=true',sql)
        self.assertIn('bb_log_content_tombstones',sql)


class ExportTests(unittest.TestCase):
    def test_drains_all_pages_to_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            pages=[{'items':[{'id':i} for i in range(50)],'next_cursor':'next'}, {'items':[{'id':i} for i in range(50,111)],'next_cursor':None}]
            invoke=mock.Mock(side_effect=pages)
            result=exporter.export('team','unused','logs api',pathlib.Path(tmp)/'logs.jsonl',invoke)
            self.assertEqual(result['rows'],111)
            self.assertEqual(invoke.call_args.args[0][-2:],['--cursor','next'])
    def test_content_bytes_preserved_across_utf8_page_boundaries(self):
        data='日志内容😀'.encode(); checksum=common.digest(data)
        pages=[]
        for at in range(0,len(data),5):
            part=data[at:at+5]
            pages.append({'offset':at,'encoding':'base64','data':base64.b64encode(part).decode(),'redacted_sha256':checksum,'next_offset':at+len(part) if at+len(part)<len(data) else None})
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'content.txt'
            exporter.export('team','unused','content exec a --reason debug',path,mock.Mock(side_effect=pages))
            self.assertEqual(path.read_bytes(),data)
    def test_changed_content_keeps_only_partial_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'content.txt'
            page={'offset':0,'encoding':'base64','data':'YQ==','redacted_sha256':'0'*64,'next_offset':None}
            with self.assertRaises(ValueError): exporter.export('team','unused','content exec a --reason debug',path,lambda cmd:page)
            self.assertFalse(path.exists()); self.assertTrue(path.with_name('content.txt.partial').exists())
    def test_repeated_cursor_does_not_create_false_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'logs.jsonl'
            with self.assertRaises(ValueError): exporter.export('team','unused','logs',path,lambda cmd:{'items':[],'next_cursor':'loop'})
            self.assertFalse(path.exists())
    def test_concurrent_destination_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'logs.jsonl'
            def invoke(command):
                path.write_text('another completed export')
                return {'items':[{'id':1}],'next_cursor':None}
            with self.assertRaises(FileExistsError): exporter.export('team','unused','logs',path,invoke)
            self.assertEqual(path.read_text(),'another completed export')
            self.assertTrue(path.with_name('logs.jsonl.partial').exists())


if __name__=='__main__': unittest.main()
