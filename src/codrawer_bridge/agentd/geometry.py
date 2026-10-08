"""Physical handwriting calibration, selected explicitly by the device launcher.

rM2: manufacturer panel specification 1404 x 1872 at 226 PPI. These are
nominal physical dimensions, not the size of the chassis or digitizer ranges.
The legacy Paper Pro profile remains the default for existing installations.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Geometry:
    page_units: tuple[float, float]
    page_mm: tuple[float, float]

    @property
    def mm_per_pu(self) -> float:
        return self.page_mm[0] / self.page_units[0]


def geometry_for(model: str) -> Geometry:
    if model == "rm2":
        mm = 25.4 / 226
        return Geometry((1404.0, 1872.0), (1404 * mm, 1872 * mm))
    if model == "paper-pro":
        return Geometry((1620.0, 2160.0), (179.6, 239.5))
    raise ValueError(f"Unknown CODRAWER_TABLET_MODEL: {model!r}")


GEOMETRY = geometry_for(os.environ.get("CODRAWER_TABLET_MODEL", "paper-pro"))
