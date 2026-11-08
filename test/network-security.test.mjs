import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { addressAllowed, validateEndpointUrl, validateEndpointUrlWithDns,
  createSafeFetch, readBoundedText } from '../lib/network.js';
import { queryProxyAdapter } from '../lib/adapters.js';

test('normalized IPv4, mapped IPv6, private, metadata and reserved addresses are blocked', () => {
  const blocked=['0.0.0.0','10.1.2.3','127.0.0.1','169.254.169.254','100.100.100.200',
    '100.64.0.1','172.31.255.255','192.168.2.1','198.18.0.1','224.0.0.1','255.255.255.255',
    '::','::1','::ffff:127.0.0.1','::ffff:169.254.169.254','::ffff:10.0.0.1',
    'fe80::1','fe90::1','febf::1','fc00::1','fd00::1','ff02::1','64:ff9b::a00:1',
    '2001:db8::1','2002:a00:1::1'];
  for(const address of blocked) assert.equal(addressAllowed(address,{allowLoopback:false}),false,address);
  for(const host of ['2130706433','0x7f000001','0177.0.0.1','[::ffff:7f00:1]'])
    assert.equal(validateEndpointUrl(`https://${host}/`,{allowLoopback:false}).ok,false,host);
  assert.equal(addressAllowed('8.8.8.8'),true);
  assert.equal(addressAllowed('2606:4700:4700::1111'),true);
});

test('local proxy permission is explicit; remote HTTP and URL credentials are rejected', async () => {
  assert.equal(validateEndpointUrl('http://127.0.0.1:3000/').ok,true);
  assert.equal(validateEndpointUrl('http://[::1]:3000/').ok,true);
  assert.equal(validateEndpointUrl('http://localhost:3000/').ok,true);
  assert.equal(validateEndpointUrl('http://gateway.example/').ok,false);
  assert.equal(validateEndpointUrl('https://user:pass@gateway.example/').ok,false);
  assert.equal(validateEndpointUrl('https://metadata.google.internal./').ok,false);
  const rebound=await validateEndpointUrlWithDns('https://gateway.example/',{
    lookupImpl:async()=>[{address:'127.0.0.1',family:4}],allowLoopback:true,
  });
  assert.equal(rebound.ok,false,'remote name must not inherit the local proxy exception');
});

test('DNS errors, empty/invalid/mixed records and mapped private answers fail closed', async () => {
  const answers=[[],[{address:'not-an-ip',family:4}],[{address:'8.8.8.8',family:6}],
    [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],
    [{address:'::ffff:a9fe:a9fe',family:6}]];
  for(const records of answers) assert.equal((await validateEndpointUrlWithDns('https://gateway.example/',{lookupImpl:async()=>records})).ok,false);
  assert.equal((await validateEndpointUrlWithDns('https://gateway.example/',{lookupImpl:async()=>{throw Error('resolver failure')}})).ok,false);
  assert.equal((await validateEndpointUrlWithDns('https://gateway.example/',{lookupImpl:()=>new Promise(()=>{}),dnsTimeoutMs:15})).ok,false);
});

test('blocked DNS destination never reaches an outgoing request', async () => {
  let requests=0;
  const fetch=createSafeFetch({lookupImpl:async()=>[{address:'169.254.169.254',family:4}],
    requestHttps:()=>{requests++;throw Error('must not execute')}});
  await assert.rejects(fetch('https://gateway.example/',{headers:{Authorization:'Bearer audit-dummy'}}),/dns_resolved/);
  assert.equal(requests,0);
});

test('safe transport pins checked DNS answers and preserves HTTPS hostname verification', async () => {
  let lookups=0;const selected=[];let seen;
  const fetch=createSafeFetch({lookupImpl:async()=>{lookups++;return [{address:lookups===1?'8.8.8.8':'169.254.169.254',family:4}]},
    requestHttps:(url,options,callback)=>{
      seen={url,options};
      options.lookup(url.hostname,{all:true},(_error,addresses)=>selected.push(addresses));
      options.lookup(url.hostname,{},(_error,address,family)=>selected.push({address,family}));
      const req=new EventEmitter();req.write=()=>{};
      req.end=()=>queueMicrotask(()=>{const res=new PassThrough();res.statusCode=200;res.headers={};callback(res);res.end('{"ok":true}')});
      return req;
    }});
  const res=await fetch('https://quota.example/v1',{headers:{Host:'evil.example','proxy-authorization':'dummy'}});
  assert.deepEqual(await res.json(),{ok:true});assert.equal(lookups,1);
  assert.deepEqual(selected,[[{address:'8.8.8.8',family:4}],{address:'8.8.8.8',family:4}]);
  assert.equal(seen.url.hostname,'quota.example');
  assert.equal(seen.options.rejectUnauthorized,true);assert.equal(seen.options.agent,false);
  assert.equal(seen.options.headers.host,undefined);assert.equal(seen.options.headers['proxy-authorization'],undefined);
  assert.equal(seen.options.checkServerIdentity,undefined,'keep Node certificate hostname checks');
});

async function localServer(t,handler) {
  const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  return server.address().port;
}

test('real local HTTP socket uses the pinned localhost answer without a second resolution', async t => {
  let host;const port=await localServer(t,(req,res)=>{host=req.headers.host;res.end('{"value":42}')});
  let lookups=0;
  const fetch=createSafeFetch({lookupImpl:async()=>{lookups++;return [{address:lookups===1?'127.0.0.1':'169.254.169.254',family:4}]}});
  const result=await fetch(`http://localhost:${port}/quota`);
  assert.deepEqual(await result.json(),{value:42});assert.equal(lookups,1);assert.equal(host,`localhost:${port}`);
});

test('real HTTP redirect does not contact its destination or forward the token', async t => {
  const paths=[];const port=await localServer(t,(req,res)=>{paths.push(req.url);res.writeHead(302,{Location:'/secret-destination'});res.end()});
  const result=await createSafeFetch()(`http://127.0.0.1:${port}/start`,{redirect:'follow',headers:{Authorization:'Bearer audit-dummy'}});
  assert.equal(result.status,302);assert.deepEqual(paths,['/start']);
});

test('stream reader cancels excess data and counts UTF-8 bytes rather than characters', async () => {
  let cancelled=false;
  const response=new Response(new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode('秘密'))},cancel(){cancelled=true}}));
  await assert.rejects(readBoundedText(response,8),{name:'PayloadTooLargeError'});
  assert.equal(cancelled,true);
  let earlyCancel=false;
  const declared=new Response(new ReadableStream({cancel(){earlyCancel=true}}),{headers:{'Content-Length':'9999'}});
  await assert.rejects(readBoundedText(declared,8),{name:'PayloadTooLargeError'});assert.equal(earlyCancel,true);
});

test('real transport stops chunked oversized and decompressed oversized responses', async t => {
  const port=await localServer(t,(req,res)=>{
    if(req.url==='/gzip'){res.setHeader('Content-Encoding','gzip');res.end(gzipSync('x'.repeat(20000)))}
    else {res.write('a'.repeat(80));res.end('b'.repeat(80))}
  });
  const fetch=createSafeFetch();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/large`,{maxBodyBytes:100}),{name:'PayloadTooLargeError'});
  await assert.rejects(fetch(`http://127.0.0.1:${port}/gzip`,{maxBodyBytes:1000}),{name:'PayloadTooLargeError'});
});

test('real transport decodes bounded gzip JSON and interrupts stalled bodies', async t => {
  const port=await localServer(t,(req,res)=>{
    if(req.url==='/gzip'){res.setHeader('Content-Encoding','gzip');res.end(gzipSync('{"ok":true}'))}
    else {res.writeHead(200);res.write('partial')}
  });
  const fetch=createSafeFetch();
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/gzip`)).json(),{ok:true});
  await assert.rejects(fetch(`http://127.0.0.1:${port}/stall`,{timeoutMs:40}));
});

test('production proxy adapter uses the safe transport; local OneAPI still works', async t => {
  let auth;const port=await localServer(t,(req,res)=>{auth=req.headers.authorization;res.end(JSON.stringify({code:0,data:{total_granted:10,total_used:2,total_available:8}}))});
  const result=await queryProxyAdapter({proxyType:'oneapi',baseURL:`http://127.0.0.1:${port}`,secret:'audit-dummy'});
  assert.equal(result.ok,true);assert.equal(auth,'Bearer audit-dummy');
  const blocked=await queryProxyAdapter({proxyType:'oneapi',baseURL:'http://[::ffff:169.254.169.254]',secret:'audit-dummy'});
  assert.equal(blocked.ok,false);assert.equal(blocked.code,'invalid_url');
});

test('unknown, prototype-named and malformed encodings reject without hanging or unhandled errors', {timeout:1500}, async t => {
  const port=await localServer(t,(req,res)=>{
    res.setHeader('Content-Encoding',req.url.slice(1));res.end('not-compressed-data');
  });
  for(const encoding of ['constructor','__proto__','unknown','gzip','br','deflate']) {
    await assert.rejects(createSafeFetch()(`http://127.0.0.1:${port}/${encoding}`,{timeoutMs:100}));
  }
});

test('deflate and brotli decode correctly and reject compression bombs', async t => {
  const port=await localServer(t,(req,res)=>{
    const [encoding,mode]=req.url.slice(1).split('/');
    res.setHeader('Content-Encoding',encoding);
    const body=mode==='large'?'x'.repeat(20000):'{"ok":true}';
    res.end((encoding==='br'?brotliCompressSync:deflateSync)(Buffer.from(body)));
  });
  const fetch=createSafeFetch();
  for(const encoding of ['br','deflate']) {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/${encoding}/small`)).json(),{ok:true});
    await assert.rejects(fetch(`http://127.0.0.1:${port}/${encoding}/large`,{maxBodyBytes:512}),{name:'PayloadTooLargeError'});
  }
});

test('oversized response headers and early peer disconnect fail safely', async t => {
  const port=await localServer(t,(req,res)=>{
    if(req.url==='/headers'){res.setHeader('X-Large','x'.repeat(20000));res.end('{}')}
    else {res.writeHead(200,{'Content-Length':'100'});res.write('partial');setImmediate(()=>res.destroy())}
  });
  await assert.rejects(createSafeFetch()(`http://127.0.0.1:${port}/headers`));
  await assert.rejects(createSafeFetch()(`http://127.0.0.1:${port}/disconnect`));
});

test('request deadline and pre-aborted signals prevent connection while DNS is stalled', async () => {
  let requests=0;
  const fetch=createSafeFetch({lookupImpl:()=>new Promise(()=>{}),requestHttps:()=>{requests++}});
  await assert.rejects(fetch('https://quota.example/',{timeoutMs:20}),{name:'TimeoutError'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(fetch('https://quota.example/',{signal:controller.signal}));
  assert.equal(requests,0);
});

test('additional platform, documentation and scoped IPv6 destinations are denied', () => {
  for(const address of ['168.63.129.16','192.0.2.1','198.51.100.1','203.0.113.1','3fff::1','fe80::1%eth0'])
    assert.equal(addressAllowed(address,{allowLoopback:false}),false,address);
});
