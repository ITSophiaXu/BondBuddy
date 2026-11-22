"""Read the trusted current projection for a host-selected bounded chapter batch."""
import json
import sys
from .fixed_edit import load_editor, read_json, workspace_lock
from .template_manifest import describe_nodes
from .workflow_descriptors import bounded_nodes

def inspect_nodes(input_path, operations_path, ids):
    if not isinstance(ids,list) or not 1 <= len(ids) <= 12 or len(set(ids)) != len(ids):
        raise ValueError('CHAPTER_SCOPE_INVALID')
    with workspace_lock(operations_path):
        _, _, _, _, editor=load_editor(input_path,operations_path)
        if any(key not in editor.nodes for key in ids):
            raise ValueError('CHAPTER_SCOPE_INVALID')
        nodes=bounded_nodes(describe_nodes(editor.nodes,selected={key:editor.nodes[key] for key in ids}))
        if sum(len(n['text']) for n in nodes)>18000:
            raise ValueError('CHAPTER_CONTEXT_TOO_LARGE')
        return {'version':'workflow-node-projection-v1','projection_version':editor.projection_version,'nodes':nodes}

def main():
    try:
        print(json.dumps(inspect_nodes(sys.argv[1],sys.argv[2],read_json(sys.argv[3])),ensure_ascii=False))
        return 0
    except (OSError,ValueError) as exc:
        print(str(exc),file=sys.stderr)
        return 1

if __name__=='__main__':
    sys.exit(main())
