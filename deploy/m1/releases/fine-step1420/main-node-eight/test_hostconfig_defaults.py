import copy,importlib.util,json,pathlib,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('adapter',ROOT/'main-cutover-adapter.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class HostConfigDefaults(unittest.TestCase):
 def check(self,actual):
  with tempfile.TemporaryDirectory() as folder:
   s=a.Main.__new__(a.Main);s.root=pathlib.Path(folder);s.p={};old={'Config':{'Env':[],'Labels':{},'Hostname':'old','Image':'same'},'HostConfig':{'OomKillDisable':None,'Memory':268435456,'SecurityOpt':['no-new-privileges:true'],'NetworkMode':'bb-main_default'}};(s.root/'ops.inspect.private.json').write_text(json.dumps(old));new=copy.deepcopy(old);new['HostConfig'].update(actual);return s.config_check('ops',new,'candidate')
 def test_explicit_false_equals_unset_oom_disable(self):self.assertTrue(self.check({'OomKillDisable':False}))
 def test_true_oom_disable_still_rejected(self):
  with self.assertRaisesRegex(RuntimeError,'EFFECTIVE_HOST_CONFIG_DRIFT'):self.check({'OomKillDisable':True})
 def test_other_host_settings_still_compared(self):
  for change in ({'Memory':536870912},{'SecurityOpt':[]},{'NetworkMode':'host'}):
   with self.subTest(change=change),self.assertRaisesRegex(RuntimeError,'EFFECTIVE_HOST_CONFIG_DRIFT'):self.check({'OomKillDisable':False,**change})
if __name__=='__main__':unittest.main(verbosity=2)