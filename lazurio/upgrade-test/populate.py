#!/usr/bin/env python3
"""Fills the test brain with fictional data through MCP, the way Hermes/Executor write:
put_page with wikilinks, add_link, remember (single + items). Prints a summary."""
import json
import sys
sys.path.insert(0, sys.argv[1])
from mcp import Mcp  # noqa: E402

base, token_file = sys.argv[2], sys.argv[3]
m = Mcp(base, open(token_file).read().strip())
m.init()
out = {}
pages = {
    'people/bob-tester': ('person', 'Bob Tester', 'Bob runs [[companies/example-org]] and works on [[projects/brain-map]].'),
    'people/alena-tester': ('person', 'Alena Tester', 'Alena is a member of [[companies/example-org]]; she reviews [[projects/brain-map]].'),
    'companies/example-org': ('company', 'Example Org', 'A fictional organization. Owner: [[people/bob-tester]].'),
    'projects/brain-map': ('project', 'Brain map', 'Memory map in Apps. Lead [[people/bob-tester]]. Uses [[concepts/knowledge-graph]].'),
    'concepts/knowledge-graph': ('concept', 'Knowledge graph', 'Pages and typed links between them.'),
}
for i in range(1, 16):
    pages[f'notes/test-note-{i:02d}'] = ('note', f'Test note {i}', f'Note {i} about [[projects/brain-map]] and [[people/alena-tester]].')
for slug, (typ, title, body) in pages.items():
    content = f'---\ntype: {typ}\ntitle: {title}\ntags: [test, gbrain-upgrade]\n---\n\n# {title}\n\n{body}\n'
    r = m.call('put_page', {'slug': slug, 'content': content, 'content_origin': 'user_said', 'wait_ms': 5000})
    out.setdefault('put_page', []).append([slug, r['isError'], (r['result'] or {}).get('status') if isinstance(r['result'], dict) else str(r['result'])[:120]])
for frm, to, lt in [('people/bob-tester', 'companies/example-org', 'works_at'),
                    ('people/alena-tester', 'companies/example-org', 'works_at'),
                    ('projects/brain-map', 'concepts/knowledge-graph', 'mentions')]:
    r = m.call('add_link', {'from': frm, 'to': to, 'link_type': lt})
    out.setdefault('add_link', []).append([frm, to, r['isError'], str(r['result'])[:160]])
facts = [('bob-tester', 'Bob prefers short written status updates.', 'preference'),
         ('bob-tester', 'Bob committed to review the brain map by Friday.', 'commitment'),
         ('alena-tester', 'Alena tests in a clean browser profile.', 'fact')]
for ent, fact, kind in facts:
    r = m.call('remember', {'source_id': 'default', 'entity': ent, 'fact': fact, 'kind': kind,
                            'visibility': 'world', 'provenance': 'gbrain upgrade test (fictional data)'})
    out.setdefault('remember', []).append([ent, r['isError'], str(r['result'])[:300]])
r = m.call('remember', {'source_id': 'default', 'items': [
    {'entity': 'example-org', 'fact': 'Example Org uses a weekly release train.', 'kind': 'fact'},
    {'entity': 'example-org', 'fact': 'Example Org meeting moved to Tuesday.', 'kind': 'event', 'ttl': '30d'}],
    'provenance': 'gbrain upgrade test (fictional data, batch)', 'visibility': 'world'})
out['remember_items'] = [r['isError'], str(r['result'])[:400]]
print(json.dumps(out, indent=1))
