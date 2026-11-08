import dns from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

// Node validates and canonicalizes addresses; BlockList also normalizes mapped IPv6.
const reserved4 = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['100.64.0.0',10],['169.254.0.0',16],
  ['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['198.18.0.0',15],
  ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) reserved4.addSubnet(ip,bits,'ipv4');
reserved4.addAddress('168.63.129.16','ipv4'); // Azure platform virtual address.
const private4 = new BlockList();
for (const [ip,bits] of [['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16]]) private4.addSubnet(ip,bits,'ipv4');
const loop4 = new BlockList(); loop4.addSubnet('127.0.0.0',8,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
const private6 = new BlockList(); private6.addSubnet('fc00::',7,'ipv6');
const special6 = new BlockList();
for (const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) special6.addSubnet(ip,bits,'ipv6');

export function addressAllowed(address, {allowLoopback=true,allowPrivate=false}={}) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (!family) return false;
  // Canonical WHATWG representation exposes ::ffff:0:0/96 mapped IPv4 reliably.
  if (family === 6) {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1,-1);
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
    if (mapped) {
      const high=parseInt(mapped[1],16), low=parseInt(mapped[2],16);
      return addressAllowed(`${high>>>8}.${high&255}.${low>>>8}.${low&255}`, {allowLoopback,allowPrivate});
    }
    if (canonical === '::1') return allowLoopback;
    if (private6.check(address,'ipv6')) return allowPrivate;
    return global6.check(address,'ipv6') && !special6.check(address,'ipv6');
  }
  if (reserved4.check(address,'ipv4')) return false;
  if (loop4.check(address,'ipv4')) return allowLoopback;
  if (private4.check(address,'ipv4')) return allowPrivate;
  return true;
}

export function validateEndpointUrl(rawUrl, options={}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return {ok:false,reason:'empty_url'};
  let url;
  try { url=new URL(rawUrl.trim()); } catch { return {ok:false,reason:'invalid_url'}; }
  if (!['http:','https:'].includes(url.protocol)) return {ok:false,reason:'unsupported_protocol'};
  if (url.protocol==='http:' && options.allowHttp===false) return {ok:false,reason:'http_not_allowed'};
  if (url.username || url.password) return {ok:false,reason:'credentials_in_url'};
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  if (!host || host==='metadata' || host==='metadata.goog' || host==='metadata.google.internal' || host.endsWith('.internal')) return {ok:false,reason:'ssrf_blocked_metadata'};
  if (isIP(host) && !addressAllowed(host,options)) return {ok:false,reason:'ssrf_blocked_address'};
  if ((host==='localhost' || host.endsWith('.localhost')) && options.allowLoopback===false) return {ok:false,reason:'ssrf_blocked_loopback'};
  const localHost=host==='localhost' || host.endsWith('.localhost') || loop4.check(host,isIP(host)===6?'ipv6':'ipv4') || host==='::1';
  if (url.protocol==='http:' && options.allowHttp!==true && !localHost) return {ok:false,reason:'https_required'};
  return {ok:true,url,origin:url.origin,basePath:url.pathname.replace(/\/+$/,'')};
}

export async function validateEndpointUrlWithDns(rawUrl, options={}) {
  const checked=validateEndpointUrl(rawUrl,options);
  if (!checked.ok) return checked;
  const host=checked.url.hostname.replace(/^\[|\]$/g,'');
  if (isIP(host)) return {...checked,addresses:[{address:host,family:isIP(host)}]};
  const lookup=options.lookupImpl ?? dns.lookup;
  let timer;
  try {
    const records=await Promise.race([
      Promise.resolve().then(()=>lookup(host,{all:true})),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('dns-timeout')),options.dnsTimeoutMs ?? 5000);}),
    ]);
    if (!Array.isArray(records) || !records.length) return {ok:false,reason:'dns_empty'};
    for (const rec of records) {
      if (!rec || !isIP(rec.address) || ![4,6].includes(rec.family) || rec.family!==isIP(rec.address)) return {ok:false,reason:'dns_invalid_address'};
      // A remote hostname resolving to loopback is not an explicit local proxy.
      const localName=/^(?:.+\.)?localhost\.?$/i.test(host);
      if (!addressAllowed(rec.address,{...options,allowLoopback:options.allowLoopback !== false && localName})) return {ok:false,reason:'dns_resolved_ssrf_blocked_address'};
    }
    return {...checked,addresses:records.map(({address,family})=>({address,family}))};
  } catch { return {ok:false,reason:'dns_failed'}; }
  finally {clearTimeout(timer);}
}

export class PayloadTooLargeError extends Error {
  constructor(){super('payload-too-large');this.name='PayloadTooLargeError';}
}

export async function readBoundedText(source, limit=64*1024) {
  const declared=source.headers?.get?.('content-length') ?? source.headers?.['content-length'];
  const body=source.body?.getReader ? source.body : (source[Symbol.asyncIterator] ? source : source.body);
  const cancel=async()=> { if (body?.cancel) await body.cancel().catch(()=>{}); else if (body?.destroy) body.destroy(); };
  if (declared!=null && Number(declared)>limit) {await cancel();throw new PayloadTooLargeError();}
  const chunks=[];let size=0;
  if (body?.getReader) {
    const reader=body.getReader();
    try {
      for (;;) {
        const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;
        if(size>limit){await reader.cancel();throw new PayloadTooLargeError();}
        chunks.push(Buffer.from(value));
      }
    } finally {reader.releaseLock();}
  } else if (body?.[Symbol.asyncIterator]) {
    for await (const chunk of body) {
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      size+=bytes.length;if(size>limit){await cancel();throw new PayloadTooLargeError();}chunks.push(bytes);
    }
  } else {
    // Compatibility for already-buffered host requests and explicit test doubles.
    const text=await source.text();
    if(Buffer.byteLength(text,'utf8')>limit)throw new PayloadTooLargeError();return text;
  }
  return Buffer.concat(chunks,size).toString('utf8');
}

// The transport always uses the checked address, never a second DNS lookup.
// Hostname, Host header, SNI and TLS certificate verification remain the original origin.
export function createSafeFetch({lookupImpl=dns.lookup,requestHttp=http.request,requestHttps=https.request}={}) {
  return async function safeFetch(url, init={}) {
    const timeoutMs=init.timeoutMs ?? 15000;
    const signal=init.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const checked=await new Promise((resolve,reject)=>{
      const abort=()=>reject(signal.reason);
      if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});
      validateEndpointUrlWithDns(String(url),{lookupImpl,allowLoopback:init.allowLoopback ?? true,allowPrivate:false})
        .then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
    if(!checked.ok)throw new Error(checked.reason);
    signal.throwIfAborted();
    const selected=checked.addresses[0];
    const pinnedLookup=(_hostname,options,callback)=>{
      if(typeof options==='function'){callback=options;options={};}
      if(options?.all)callback(null,[selected]);else callback(null,selected.address,selected.family);
    };
    const headers=new Headers(init.headers);
    // Callers cannot override authority or inject proxy credentials.
    headers.delete('host');headers.delete('proxy-authorization');headers.set('accept-encoding','identity');
    const maxBodyBytes=init.maxBodyBytes ?? 64*1024;
    const request=checked.url.protocol==='https:' ? requestHttps : requestHttp;
    return new Promise((resolve,reject)=>{
      const req=request(checked.url,{
        method:init.method ?? 'GET',headers:Object.fromEntries(headers),
        lookup:pinnedLookup,agent:false,autoSelectFamily:false,signal,
        rejectUnauthorized:true,maxHeaderSize:16*1024,
      },async res=>{
        let decoded=res;
        const onError=()=>decoded.destroy(new Error('response-stream-failed'));
        try {
          // No redirects are followed, even if a caller requests redirect:'follow'.
          if(res.statusCode>=300 && res.statusCode<400){res.destroy();return resolve(new Response(null,{status:res.statusCode,headers:res.headers}));}
          const encoding=String(res.headers['content-encoding']??'identity').toLowerCase();
          const decoders=new Map([['gzip',createGunzip],['deflate',createInflate],['br',createBrotliDecompress]]);
          if(encoding!=='identity'){
            const decoder=decoders.get(encoding);
            if(!decoder)throw new Error('unsupported-content-encoding');
            decoded=decoder();res.on('error',onError);res.pipe(decoded);
          }
          let wireBytes=0;
          res.on('data',chunk=>{wireBytes+=chunk.length;if(wireBytes>maxBodyBytes){decoded.destroy(new PayloadTooLargeError());if(decoded!==res)res.destroy();}});
          // Bounds decoded bytes as well as wire bytes, including compression bombs.
          const text=await readBoundedText(decoded,maxBodyBytes);
          const responseHeaders=new Headers();
          for(const [k,v] of Object.entries(res.headers))if(v!==undefined && !['content-encoding','content-length','transfer-encoding'].includes(k))responseHeaders.set(k,Array.isArray(v)?v.join(', '):String(v));
          resolve(new Response([204,205,304].includes(res.statusCode)?null:text,{status:res.statusCode,headers:responseHeaders}));
        } catch (error) {res.destroy();decoded.destroy();reject(signal.aborted ? signal.reason : error instanceof PayloadTooLargeError ? error : new Error('response-read-failed'));}
        finally {res.removeListener('error',onError);}
      });
      req.on('error', (err) => reject(signal.aborted ? signal.reason : err));
      if(init.body!=null)req.write(init.body);
      req.end();
    });
  };
}

export const safeFetch=createSafeFetch();
