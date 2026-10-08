import json
import os
import subprocess
import sys

import pytest

from codrawer_bridge.agentd.geometry import geometry_for


def test_rm2_nominal_panel_dimensions():
    g = geometry_for("rm2")
    assert g.page_mm == pytest.approx((157.7946903, 210.3929204))
    assert g.mm_per_pu == pytest.approx(25.4 / 226)


@pytest.mark.parametrize("model", ["rm2", "paper-pro"])
def test_placement_and_transmitted_ink_use_same_physical_scale(model):
    # Fresh interpreter: exercise the actual deployment environment selector and imports.
    code = """
import json
from codrawer_bridge.agentd.geometry import GEOMETRY as g
from codrawer_bridge.agentd.hand import Layout, to_messages
from codrawer_bridge.agentd.placement import MM_PER_PU
lay = Layout(20, (0, -5, 20, 15), 100, [(0,100,[[0,-5,1,0],[20,15,1,100]])])
w,h = g.page_units
origin = lay.origin_for((200,300), 1, w,h)
pts = [p for _,m in to_messages(lay,origin,1,0) if m['t']=='stroke_pts' for p in m['pts']]
span = [(pts[-1][i]-pts[0][i])*g.page_mm[i] for i in (0,1)]
print(json.dumps({'span_mm': span, 'corner_pu': [pts[0][0]*w,pts[0][1]*h],
                  'block_mm': lay.block(0,1).w*MM_PER_PU}))
"""
    env = dict(os.environ, CODRAWER_TABLET_MODEL=model)
    data = json.loads(subprocess.check_output([sys.executable, "-c", code], env=env, text=True))
    assert data["span_mm"] == pytest.approx([20, 20], abs=0.005)
    assert data["corner_pu"] == pytest.approx([200, 300], abs=0.02)
    assert data["block_mm"] == pytest.approx(20)


def test_invalid_device_fails_instead_of_silently_using_wrong_scale():
    with pytest.raises(ValueError):
        geometry_for("unknown")
