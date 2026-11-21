"""Bounded model views; full text remains in the trusted editor and child nodes."""
import hashlib


def bounded_nodes(described):
    output = []
    for source in described:
        node = {key: source[key] for key in ('node_id', 'part', 'kind', 'text', 'parent_node_id',
                'limitations', 'style_id', 'outline_level', 'rows', 'cells') if key in source}
        text = node['text']
        # Aggregates repeat all child paragraph text. Keep their exact hash as
        # an editing anchor, while the child rows/cells/paragraphs carry content.
        if node['kind'] in {'table', 'row', 'cell'} and len(text) > 18000:
            node.update(text='', text_sha256=hashlib.sha256(text.encode('utf-8')).hexdigest(),
                        text_chars=len(text), scope_only=True)
        if node['kind'] == 'table':
            rows = node.get('rows', 0)
            node['row_groups'] = [{'table_node_id': node['node_id'], 'start_row': start,
                                   'row_count': min(128, rows - start), 'offset_unit': 'row_index'}
                                  for start in range(0, rows, 128)]
        output.append(node)
    return output
