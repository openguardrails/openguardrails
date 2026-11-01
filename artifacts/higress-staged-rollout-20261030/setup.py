import json, pathlib
root=pathlib.Path('/tmp/og-dual-rollout-e2e/data')
def put(folder,name,kind,spec,annotations=None,api=None):
 d={'apiVersion':api or 'networking.higress.io/v1','kind':kind,'metadata':{'name':name,'namespace':'higress-system','resourceVersion':'1','annotations':annotations or {},'labels':{'higress.io/wasm-plugin-built-in':'false'}},'spec':spec}
 p=root/folder/(name+'.yaml');p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d))
put('mcpbridges','default','McpBridge',{'registries':[{'name':'rollout-mock','type':'static','protocol':'http','domain':'172.17.0.1:18090','port':80}]})
for name in ['normal','empty','all']:
 put('ingresses','rollout-'+name,'Ingress',{'ingressClassName':'higress','rules':[{'host':name+'.rollout.test','http':{'paths':[{'path':'/','pathType':'Prefix','backend':{'resource':{'apiGroup':'networking.higress.io','kind':'McpBridge','name':'default'}}}]}}]}, {'higress.io/destination':'rollout-mock.static:80'},'networking.k8s.io/v1')
def cfg(value):
 return {'og_cluster':'outbound|80||rollout-mock.static','og_base_url':'http://mock','og_api_key':'test-only','enable_input_detection':True,'enable_output_detection':True,'staged_rollout':value}
put('wasmplugins','rollout-test','WasmPlugin',{'url':'file:///data/plugin.wasm','priority':200,'phase':'UNSPECIFIED_PHASE','failStrategy':'FAIL_CLOSE','defaultConfigDisable':False,'defaultConfig':cfg('team-gray, consumer-gray, ungrouped'),'matchRules':[{'ingress':['rollout-empty'],'config':cfg('')},{'ingress':['rollout-all'],'config':cfg('all_consumers')}]},api='extensions.higress.io/v1alpha1')

def airs_cfg(value):
 return {'runtime_cluster':'outbound|80||rollout-mock.static','runtime_base_url':'http://mock','api_key':'test-only','mode':'enforce','fail_mode':'closed','staged_rollout':value,'log_level':'info'}
put('wasmplugins','airs-rollout-test','WasmPlugin',{'url':'file:///data/airs.wasm','priority':210,'phase':'UNSPECIFIED_PHASE','failStrategy':'FAIL_CLOSE','defaultConfigDisable':False,'defaultConfig':airs_cfg('team-gray, consumer-gray, ungrouped'),'matchRules':[{'ingress':['rollout-empty'],'config':airs_cfg('')},{'ingress':['rollout-all'],'config':airs_cfg('all_consumers')}]},api='extensions.higress.io/v1alpha1')
