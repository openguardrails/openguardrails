import json,time
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path
log=Path('/tmp/og-dual-rollout-e2e/calls.jsonl')
class H(BaseHTTPRequestHandler):
 protocol_version="HTTP/1.1"
 def log_message(self,*a): pass
 def do_POST(self):
  if self.headers.get('Transfer-Encoding','').lower() == 'chunked':
   raw=b''
   while True:
    size=int(self.rfile.readline().split(b';')[0],16)
    if not size:
     self.rfile.readline();break
    raw+=self.rfile.read(size);self.rfile.read(2)
  else: raw=self.rfile.read(int(self.headers.get('Content-Length',0)))
  b=json.loads(raw)
  with log.open('a') as f:f.write(json.dumps({'path':self.path,'body':b,'headers':dict(self.headers)})+'\n')
  if self.path=='/v1/evaluate' and (log.parent/'delay-seconds').exists():
   time.sleep(float((log.parent/'delay-seconds').read_text()))
  if self.path in ('/v1/evaluate','/v1/heartbeat'):
   out=json.dumps({'decision':'allow','response_policy':{'pii':'off'}}).encode();typ='application/json'
  elif self.path.startswith('/v1/gateway/'):
   out=json.dumps({'action':'pass'}).encode();typ='application/json'
  elif b.get('stream'):
   out=b'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","model":"test","choices":[{"index":0,"delta":{"content":"mock reply"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-test","object":"chat.completion.chunk","model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' ;typ='text/event-stream'
  else:
   out=b'{"choices":[{"message":{"role":"assistant","content":"mock reply"}}]}';typ='application/json'
  self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Content-Length',str(len(out)));self.end_headers();self.wfile.write(out)
ThreadingHTTPServer(('0.0.0.0',18090),H).serve_forever()
