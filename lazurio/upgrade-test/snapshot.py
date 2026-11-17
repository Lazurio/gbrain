#!/usr/bin/env python3
"""snapshot.py <harness-dir> <base> <rw-token> <ro-token> <admin-token-file> <out.json>
Reads the brain over MCP with the same calls Hermes, Executor and Machines use, plus
the map thread's read calls, and stores a comparable snapshot (counts, ids, shapes)."""
import json
import sys
sys.path.insert(0, sys.argv[1])
from mcp import Mcp, admin_opener, request  # noqa: E402

base, rw, ro, admin_file, out_file = sys.argv[2:7]
m = Mcp(base, open(rw).read().strip()); m.init()
r = Mcp(base, open(ro).read().strip()); r.init()


def shape(v, depth=0):
    if isinstance(v, dict):
        return {k: shape(x, depth + 1) for k, x in sorted(v.items())} if depth < 3 else 'object'
    if isinstance(v, list):
        return [shape(v[0], depth + 1)] if v else []
    return type(v).__name__


snap = {'server': None, 'calls': {}, 'shapes': {}}
ident = m.call('get_brain_identity', {})
snap['calls']['get_brain_identity'] = {k: ident['result'].get(k) for k in ('page_count', 'chunk_count', 'version', 'engine')} if isinstance(ident['result'], dict) else ident
srcs = m.call('sources_list', {})
snap['calls']['sources_list'] = [{k: s.get(k) for k in ('id', 'local_path')} for s in (srcs['result'] or {}).get('sources', [])] if isinstance(srcs['result'], dict) else srcs
who = m.call('whoami', {})
snap['calls']['whoami_rw'] = {k: who['result'].get(k) for k in ('token_name', 'scopes', 'transport')} if isinstance(who['result'], dict) else who
who = r.call('whoami', {})
snap['calls']['whoami_ro'] = {k: who['result'].get(k) for k in ('token_name', 'scopes', 'transport')} if isinstance(who['result'], dict) else who
lp = r.call('list_pages', {'limit': 100, 'sort': 'slug'})
pages = lp['result'] if isinstance(lp['result'], list) else (lp['result'] or {}).get('pages') or (lp['result'] or {}).get('items') or []
snap['shapes']['list_pages'] = shape(lp['result'])
snap['calls']['list_pages'] = sorted([(p.get('slug'), p.get('type')) for p in pages])
links, backlinks = {}, {}
for slug, _ in snap['calls']['list_pages']:
    g = r.call('get_links', {'slug': slug})
    res = g['result']
    items = res if isinstance(res, list) else (res or {}).get('links') or (res or {}).get('items') or []
    links[slug] = sorted({(i.get('to_slug') or i.get('to') or i.get('slug'), i.get('link_type')) for i in items})
    b = r.call('get_backlinks', {'slug': slug})
    res = b['result']
    items = res if isinstance(res, list) else (res or {}).get('backlinks') or (res or {}).get('links') or (res or {}).get('items') or []
    backlinks[slug] = len(items)
snap['shapes']['get_links'] = shape(r.call('get_links', {'slug': 'people/bob-tester'})['result'])
snap['shapes']['get_backlinks'] = shape(r.call('get_backlinks', {'slug': 'projects/brain-map'})['result'])
snap['calls']['links'] = {k: [list(x) for x in v] for k, v in links.items()}
snap['calls']['backlink_counts'] = backlinks
gp = r.call('get_page', {'slug': 'people/bob-tester'})
snap['shapes']['get_page'] = shape(gp['result'])
tg = r.call('traverse_graph', {'slug': 'people/bob-tester', 'depth': 2, 'direction': 'both'})
snap['shapes']['traverse_graph'] = shape(tg['result'])
tgr = tg['result']
snap['calls']['traverse_graph_size'] = len(tgr) if isinstance(tgr, list) else {k: len(v) for k, v in (tgr or {}).items() if isinstance(v, list)}
sg = r.call('schema_graph', {})
snap['shapes']['schema_graph'] = shape(sg['result'])
snap['calls']['schema_graph_error'] = sg['isError']
facts = {}
for ent in ('bob-tester', 'alena-tester', 'example-org'):
    rc = m.call('recall', {'entity': ent})
    res = rc['result'] if isinstance(rc['result'], dict) else {}
    items = res.get('facts') or res.get('items') or []
    facts[ent] = {'isError': rc['isError'], 'total': res.get('total'), 'ids': sorted(str(f.get('id')) for f in items)}
snap['calls']['recall'] = facts
snap['shapes']['recall'] = shape(m.call('recall', {'entity': 'bob-tester'})['result'])
ro_write = r.call('remember', {'entity': 'bob-tester', 'fact': 'read-only token must not write', 'source_id': 'default'})
snap['calls']['ro_token_write_refused'] = ro_write['isError'] or bool(ro_write.get('rpc_error'))
health = m.call('get_brain_health', {})
snap['calls']['get_brain_health'] = {k: health['result'].get(k) for k in ('status',)} if isinstance(health['result'], dict) else str(health['result'])[:200]
opener = admin_opener(base, admin_file)
status, raw, _ = request(opener, base, 'GET', '/admin/api/api-keys')
keys = json.loads(raw) if status == 200 else raw[:200]
snap['calls']['admin_api_keys'] = sorted([(k['name'], k.get('status'), tuple(k.get('scopes') or [])) for k in keys]) if isinstance(keys, list) else keys
json.dump(snap, open(out_file, 'w'), indent=1, default=list)
print(json.dumps({k: snap['calls'][k] for k in ('get_brain_identity', 'whoami_rw', 'whoami_ro', 'recall', 'ro_token_write_refused', 'admin_api_keys', 'get_brain_health')}, default=list))
print('pages', len(snap['calls']['list_pages']), 'links', sum(len(v) for v in links.values()))
