import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { createSafeFetch } from '../lib/network.js';

function findOpenSsl() {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    '/usr/bin/openssl',
  ];
  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ['version'], { stdio: 'ignore' });
      if (res.status === 0) return bin;
    } catch {}
  }
  return null;
}

function runOpenSsl(bin, args, cwd) {
  const res = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`OpenSSL command failed [${args.join(' ')}]: ${res.stderr || res.stdout || 'exit ' + res.status}`);
  }
}

test('独立真实本机 HTTPS 证书与域名验证（3 项硬性验证）', async () => {
  const openssl = findOpenSsl();
  if (!openssl) {
    throw new Error('Mandatory HTTPS verification requires OpenSSL, but none was found on PATH.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-https-'));
  let server = null;
  let serverWrong = null;

  try {
    const caKey = path.join(tempDir, 'ca.key');
    const caCrt = path.join(tempDir, 'ca.crt');
    const srvKey = path.join(tempDir, 'server.key');
    const srvCsr = path.join(tempDir, 'server.csr');
    const srvCrt = path.join(tempDir, 'server.crt');
    const srvCnf = path.join(tempDir, 'ext.cnf');

    const wrgKey = path.join(tempDir, 'wrong.key');
    const wrgCsr = path.join(tempDir, 'wrong.csr');
    const wrgCrt = path.join(tempDir, 'wrong.crt');
    const wrgCnf = path.join(tempDir, 'wrong-ext.cnf');

    // 1. 生成临时独立 CA
    runOpenSsl(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCrt, '-days', '1', '-subj', '/CN=Test CA'], tempDir);

    // 2. 生成带 subjectAltName=localhost 的证书
    fs.writeFileSync(srvCnf, 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n', 'utf8');
    runOpenSsl(openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', srvKey, '-out', srvCsr, '-subj', '/CN=localhost'], tempDir);
    runOpenSsl(openssl, ['x509', '-req', '-in', srvCsr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-out', srvCrt, '-days', '1', '-extfile', srvCnf], tempDir);

    // 3. 生成带 wrong.example 的证书
    fs.writeFileSync(wrgCnf, 'subjectAltName=DNS:wrong.example\nbasicConstraints=CA:FALSE\n', 'utf8');
    runOpenSsl(openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', wrgKey, '-out', wrgCsr, '-subj', '/CN=wrong.example'], tempDir);
    runOpenSsl(openssl, ['x509', '-req', '-in', wrgCsr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-out', wrgCrt, '-days', '1', '-extfile', wrgCnf], tempDir);

    const ca = fs.readFileSync(caCrt);
    const serverKey = fs.readFileSync(srvKey);
    const serverCrt = fs.readFileSync(srvCrt);
    const wrongKey = fs.readFileSync(wrgKey);
    const wrongCrt = fs.readFileSync(wrgCrt);

    let serverHits = 0;
    let receivedAuth = null;
    let recordedSni = null;
    let recordedHost = null;

    server = https.createServer({ key: serverKey, cert: serverCrt }, (req, res) => {
      serverHits += 1;
      receivedAuth = req.headers.authorization || null;
      recordedSni = req.socket.servername || null;
      recordedHost = req.headers.host || null;
      res.end(JSON.stringify({ ok: true, host: req.headers.host, sni: req.socket.servername }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    let wrongServerHits = 0;
    serverWrong = https.createServer({ key: wrongKey, cert: wrongCrt }, (req, res) => {
      wrongServerHits += 1;
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => serverWrong.listen(0, '127.0.0.1', resolve));
    const portWrong = serverWrong.address().port;

    // 验证项 1: 不受信任的证书被严格拒绝 (明确断言证书信任错误码，且请求未抵达 HTTP 处理器)
    const fetchDefault = createSafeFetch({
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    let untrustedError = null;
    try {
      await fetchDefault(`https://localhost:${port}/`, {
        headers: { Authorization: 'Bearer test-secret-token' },
      });
    } catch (err) {
      untrustedError = err;
    }
    assert.ok(untrustedError, '不受信任的自签证书必须导致连接失败');
    assert.match(
      String(untrustedError.code || untrustedError.message),
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|self.signed/i,
      `错误必须属于证书链信任失败，实际错误: ${untrustedError.code || untrustedError.message}`
    );
    assert.equal(serverHits, 0, 'TLS 握手失败时不得向 HTTP 处理程序发送请求或暴露 Authorization 凭据');
    assert.equal(receivedAuth, null);

    // 验证项 2: 显式注入测试 CA 证书正常连接，且分别断言 SNI 和 Host 标头保持原域名与端口
    const fetchWithCa = createSafeFetch({
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      requestHttps: (url, opts, cb) => https.request(url, { ...opts, ca }, cb),
    });
    const res = await fetchWithCa(`https://localhost:${port}/`, {
      headers: { Authorization: 'Bearer legitimate-token' },
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(serverHits, 1, 'CA 验证通过后应成功处理一次请求');
    assert.equal(recordedSni, 'localhost', 'TLS 握手客户端发送的 SNI 必须保持原域名');
    assert.equal(recordedHost, `localhost:${port}`, 'HTTP Host 请求头必须包含原域名与端口');
    assert.equal(receivedAuth, 'Bearer legitimate-token');

    // 验证项 3: 证书域名不匹配必须严格报错 ERR_TLS_CERT_ALTNAME_INVALID，且未发送 HTTP 请求
    let mismatchError = null;
    const fetchWrongHost = createSafeFetch({
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      requestHttps: (url, opts, cb) => https.request(url, { ...opts, ca }, cb),
    });
    try {
      await fetchWrongHost(`https://localhost:${portWrong}/`, {
        headers: { Authorization: 'Bearer leaked-token-attempt' },
      });
    } catch (err) {
      mismatchError = err;
    }
    assert.ok(mismatchError, '证书域名不匹配必须抛出异常');
    assert.equal(
      mismatchError.code,
      'ERR_TLS_CERT_ALTNAME_INVALID',
      `域名不匹配错误码必须为 ERR_TLS_CERT_ALTNAME_INVALID，实际: ${mismatchError.code}`
    );
    assert.equal(wrongServerHits, 0, '域名不匹配时 TLS 握手失败，不得向 HTTP 服务端发送请求体与凭据');
  } finally {
    await Promise.all([
      server ? new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) : Promise.resolve(),
      serverWrong ? new Promise((resolve) => { serverWrong.closeAllConnections?.(); serverWrong.close(resolve); }) : Promise.resolve(),
    ]);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});
