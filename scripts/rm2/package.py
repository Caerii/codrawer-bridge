"""Assemble only runtime, source and static assets: no credentials or local request logs."""

import tarfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
out = root / ".codrawer/rm2-build"


def keep(info):
    if "__pycache__" in info.name or info.name.endswith(".pyc"):
        return None
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    return info


with tarfile.open(out / "agent.tar.gz", "w:gz") as tar:
    for source, target in [
        (out / "runtime", "runtime"),
        (root / "src/codrawer_bridge", "src/codrawer_bridge"),
        (out / "layouts.cjs", "packages/hand/scripts/layouts.cjs"),
        (root / "apps/even-g2/dist", "web"),
        (root / "scripts/rm2/python", "bin/python"),
        (root / "scripts/rm2/node", "bin/node"),
        (root / "scripts/rm2/launch_agent.py", "launch_agent.py"),
    ]:
        tar.add(source, arcname=target, filter=keep)
print(out / "agent.tar.gz")
