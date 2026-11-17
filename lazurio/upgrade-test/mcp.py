#!/usr/bin/env python3
"""Small client for a loopback gbrain HTTP server: admin login, API keys, MCP calls.

Usage (all output JSON on stdout):
  mcp.py mint  <base> <admin-token-file> <name> <scope,scope> <out-file>
  mcp.py keys  <base> <admin-token-file>
  mcp.py tools <base> <token-file>
  mcp.py call  <base> <token-file> <tool> '<json-args>'
"""
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.request


def request(opener, base, method, path, body=None, headers=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base.rstrip('/') + path, data=data, method=method,
                                 headers={'content-type': 'application/json', **(headers or {})})
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode(), dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode(), dict(err.headers)


def admin_opener(base, admin_file):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    token = open(admin_file, encoding='utf-8').read().strip()
    status, raw, _ = request(opener, base, 'POST', '/admin/login', {'token': token})
    if status != 200:
        sys.exit(f'admin login failed: {status} {raw[:200]}')
    return opener


class Mcp:
    def __init__(self, base, token):
        self.base, self.token, self.session, self.opener = base, token, None, urllib.request.build_opener()
        self.n = 0

    def post(self, body):
        headers = {'accept': 'application/json, text/event-stream', 'authorization': 'Bearer ' + self.token}
        if self.session:
            headers['mcp-session-id'] = self.session
        status, raw, hdrs = request(self.opener, self.base, 'POST', '/mcp', body, headers, timeout=300)
        self.session = hdrs.get('Mcp-Session-Id') or hdrs.get('mcp-session-id') or self.session
        if status >= 400:
            return {'http_status': status, 'body': raw[:500]}
        if not raw.strip():
            return {}
        if raw.lstrip().startswith('{'):
            return json.loads(raw)
        data = [line[5:].strip() for line in raw.splitlines() if line.startswith('data:')]
        return json.loads(data[-1]) if data else {}

    def init(self):
        r = self.post({'jsonrpc': '2.0', 'id': 0, 'method': 'initialize',
                       'params': {'protocolVersion': '2025-03-26', 'capabilities': {},
                                  'clientInfo': {'name': 'gbrain-fork-harness', 'version': '1'}}})
        self.post({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        return r

    def rpc(self, method, params):
        self.n += 1
        return self.post({'jsonrpc': '2.0', 'id': self.n, 'method': method, 'params': params})

    def call(self, name, args):
        r = self.rpc('tools/call', {'name': name, 'arguments': args})
        res = r.get('result') or {}
        content = res.get('content') or []
        text = content[0].get('text', '') if content else ''
        try:
            parsed = json.loads(text) if text.lstrip().startswith(('{', '[')) else text
        except ValueError:
            parsed = text
        out = {'isError': bool(res.get('isError')), 'result': parsed}
        if 'error' in r or 'http_status' in r:
            out['rpc_error'] = r.get('error') or r
        return out


def main():
    cmd, base = sys.argv[1], sys.argv[2]
    if cmd == 'mint':
        admin_file, name, scopes, out = sys.argv[3:7]
        opener = admin_opener(base, admin_file)
        status, raw, _ = request(opener, base, 'POST', '/admin/api/api-keys',
                                 {'name': name, 'scopes': scopes.split(',')})
        doc = json.loads(raw) if raw.strip().startswith('{') else {'raw': raw[:300]}
        token = doc.get('token') or doc.get('key') or doc.get('api_key')
        if status != 200 or not token:
            sys.exit(f'mint failed: {status} {sorted(doc)}')
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, token.encode())
        os.close(fd)
        print(json.dumps({'status': status, 'fields': sorted(doc), 'id': doc.get('id'), 'name': doc.get('name'),
                          'scopes': doc.get('scopes') or doc.get('scopes_applied')}))
    elif cmd == 'keys':
        opener = admin_opener(base, sys.argv[3])
        for path in ('/admin/api/agents', '/admin/api/api-keys'):
            status, raw, _ = request(opener, base, 'GET', path)
            try:
                doc = json.loads(raw)
            except ValueError:
                doc = raw[:200]
            print(json.dumps({'path': path, 'status': status, 'body': doc}, default=str))
    else:
        token = open(sys.argv[3], encoding='utf-8').read().strip()
        m = Mcp(base, token)
        init = m.init()
        if cmd == 'tools':
            r = m.rpc('tools/list', {})
            tools = (r.get('result') or {}).get('tools') or []
            print(json.dumps({'init_error': init.get('error') or init.get('http_status'),
                              'server': (init.get('result') or {}).get('serverInfo'),
                              'tools': tools}))
        elif cmd == 'call':
            print(json.dumps(m.call(sys.argv[4], json.loads(sys.argv[5])), default=str))


if __name__ == '__main__':
    main()
