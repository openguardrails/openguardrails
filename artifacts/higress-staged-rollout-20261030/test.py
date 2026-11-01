import json,urllib.request,pathlib,concurrent.futures,time
from collections import Counter
root=pathlib.Path('/tmp/og-dual-rollout-e2e')
def calls():
 p=root/'calls.jsonl'
 return [json.loads(s) for s in p.read_text().splitlines() if json.loads(s)['path'] != '/v1/heartbeat'] if p.exists() else []
def request(name,route,headers,stream=False):
 body=json.dumps({'model':'test','messages':[{'role':'user','content':name}],'stream':stream}).encode()
 req=urllib.request.Request('http://127.0.0.1:28484/v1/chat/completions',data=body,headers={'Host':route+'.rollout.test','Content-Type':'application/json',**headers})
 with urllib.request.urlopen(req,timeout=15) as r:
  response=r.read().decode();rh=dict(r.headers)
 assert 'mock reply' in response,(name,response)
 assert not any(k.lower() in ('x-mse-consumer','x-mse-consumer-group','x-higress-ai-beta-flags') for k in rh),rh
 return response
cases=[
 ('normal','normal',{'x-mse-consumer':'bob','x-mse-consumer-group':'ordinary'},False),
 ('group','normal',{'x-mse-consumer':'bob','x-mse-consumer-group':'team-gray'},True),
 ('consumer','normal',{'x-mse-consumer':'consumer-gray','x-mse-consumer-group':'ordinary'},True),
 ('ungrouped','normal',{'x-mse-consumer':'bob'},True),
 ('blank-group','normal',{'x-mse-consumer':'bob','x-mse-consumer-group':'  '},True),
 ('beta','normal',{'x-mse-consumer':'bob','x-mse-consumer-group':'ordinary','x-higress-ai-beta-flags':'other, OG-AIRS '},True),
 ('both','normal',{'x-mse-consumer':'consumer-gray','x-mse-consumer-group':'team-gray','x-higress-ai-beta-flags':'og-airs'},True),
 ('substring','normal',{'x-mse-consumer':'bob','x-mse-consumer-group':'team-gray-extra','x-higress-ai-beta-flags':'og-airs-extra'},False),
 ('empty','empty',{'x-mse-consumer':'consumer-gray'},False),
 ('empty-beta','empty',{'x-mse-consumer':'bob','x-higress-ai-beta-flags':'og-airs'},True),
 ('all','all',{'x-mse-consumer':'bob','x-mse-consumer-group':'ordinary'},True),
 ('all-anonymous','all',{},True),
]
results=[]
for name,route,headers,bypass in cases:
 for stream in (False,True):
  before=len(calls());request(name,route,headers,stream)
  for _ in range(100):
   new=calls()[before:]
   if sum(c['path']=='/v1/evaluate' for c in new)==2:break
   time.sleep(0.01)
  paths=[c['path'] for c in new]
  expected=['/v1/evaluate','/v1/chat/completions','/v1/evaluate'] if bypass else ['/v1/gateway/process-input','/v1/chat/completions','/v1/evaluate','/v1/evaluate']+([] if stream else ['/v1/gateway/process-output'])
  assert Counter(paths)==Counter(expected),(name,stream,paths,expected)
  events=[c['body'] for c in new if c['path']=='/v1/evaluate']
  if events:
   assert [e['kind'] for e in events]==['step/request','step/response'],events
  results.append({'case':name,'stream':stream,'paths':paths,'passed':True})
# Mix rollouts concurrently; a normal exchange must still detect both halves.
before=len(calls())
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 tasks=[pool.submit(request,'concurrent-'+str(i),'normal',{'x-mse-consumer':'bob','x-mse-consumer-group':'ordinary' if i%2 else 'team-gray'},False) for i in range(20)]
 for task in tasks:task.result()
time.sleep(0.2)
paths=[c['path'] for c in calls()[before:]]
assert paths.count('/v1/gateway/process-input')==10,paths
assert paths.count('/v1/gateway/process-output')==10,paths
assert paths.count('/v1/chat/completions')==20,paths
assert paths.count('/v1/evaluate')==40,paths
delay=root/'delay-seconds'
delay.write_text('1.2')
try:
 start=time.monotonic()
 request('observe-delay','normal',{'x-mse-consumer':'bob','x-mse-consumer-group':'ordinary'},False)
 observe_seconds=time.monotonic()-start
 assert observe_seconds<0.8,observe_seconds
 start=time.monotonic()
 request('enforce-delay','normal',{'x-mse-consumer':'bob','x-mse-consumer-group':'team-gray'},False)
 enforce_seconds=time.monotonic()-start
 assert enforce_seconds>=2.3,enforce_seconds
finally: delay.unlink(missing_ok=True)
report={'latency_probe':{'evaluate_delay_seconds':1.2,'observe_seconds':observe_seconds,'enforce_seconds':enforce_seconds,'passed':True},'passed':len(results)+2,'cases':results,'concurrency':{'requests':20,'input_calls':10,'output_calls':10,'airs_evaluate_calls':40,'passed':True}}
(root/'results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
