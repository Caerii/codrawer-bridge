"""Dump .rm files with rmscene as JSON for cross-checking the Go parser.

Regenerate the golden file (from this directory):
    uv run --with rmscene python rmscene_dump.py rmscene.json *.rm
(rmscene 0.8.0 produced the committed rmscene.json.)
"""
import json, sys, logging, os
logging.basicConfig(level=logging.ERROR)
from rmscene import read_blocks
from rmscene.scene_stream import SceneLineItemBlock, SceneTombstoneItemBlock, TreeNodeBlock


def cid(c):
    return None if c is None else f"{c.part1}:{c.part2}"


def pt(p):
    return [p.x, p.y, p.speed, p.direction, p.width, p.pressure]


res = {}
for path in sys.argv[2:]:
    out = {"lines": [], "deleted": [], "layers": []}
    try:
        with open(path, "rb") as f:
            for b in read_blocks(f):
                if isinstance(b, SceneLineItemBlock):
                    it = b.item
                    if it.value is None:
                        out["deleted"].append(cid(it.item_id))
                        continue
                    l = it.value
                    out["lines"].append({
                        "id": cid(it.item_id), "parent": cid(b.parent_id), "tool": int(l.tool),
                        "color": int(l.color), "rgba": list(l.color_rgba) if l.color_rgba else None,
                        "thick": l.thickness_scale, "n": len(l.points),
                        "p0": pt(l.points[0]) if l.points else None,
                        "pN": pt(l.points[-1]) if l.points else None,
                        "wsum": sum(p.width for p in l.points),
                        "psum": sum(p.pressure for p in l.points),
                    })
                elif isinstance(b, SceneTombstoneItemBlock):
                    out["deleted"].append(cid(b.item.item_id))
                elif isinstance(b, TreeNodeBlock):
                    out["layers"].append({"id": cid(b.group.node_id), "label": b.group.label.value})
    except Exception as e:  # noqa
        out["error"] = repr(e)
    try:
        from rmscene import read_tree
        from rmscene import scene_items as si
        with open(path, "rb") as f:
            tree = read_tree(f)
        order = []
        def walk(g, layer):
            for iid in g.children:
                v = g.children[iid]
                if isinstance(v, si.Group):
                    walk(v, cid(v.node_id) if layer is None else layer)
                elif isinstance(v, si.Line):
                    order.append([cid(iid), layer])
        walk(tree.root, None)
        out["order"] = order
        si_ = getattr(tree, "scene_info", None)
        if si_ is not None and getattr(si_, "paper_size", None):
            out["paper"] = list(si_.paper_size)
    except Exception as e:  # noqa
        out["tree_error"] = repr(e)
    res[os.path.basename(path)] = out
    print(os.path.basename(path), "lines", len(out["lines"]), "deleted", len(out["deleted"]),
          "tools", sorted({l["tool"] for l in out["lines"]}),
          "colors", sorted({l["color"] for l in out["lines"]}), out.get("error", ""))
with open(sys.argv[1], "w") as f:
    json.dump(res, f, separators=(",", ":"), sort_keys=True)
