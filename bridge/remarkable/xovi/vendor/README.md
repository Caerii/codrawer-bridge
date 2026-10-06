# XOVI, vendored

The three files codrawer's releases ship so the tablet can start [XOVI](https://github.com/asivery/xovi)
at boot (`bridge/remarkable/boot/xovi.sh`; what it changes on the tablet and how to turn it off:
`docs/what-codrawer-changes.md`).

| File | What it is |
| --- | --- |
| `xovi.so` | XOVI v0.3.3, the loader preloaded into xochitl |
| `start` | XOVI's tethered start script (tmpfs drop-in + `LD_PRELOAD`, restarts xochitl once) |
| `stock` | XOVI's script that returns xochitl to stock |

They come unmodified from `asivery/rm-xovi-extensions`, release v19-23052026,
`xovi-aarch64.tar.gz` (sha256 `32d64d1262ddc984e3235c7d0340a398fe6d5b3efa6a979865f5977b32630d27`;
the pre-v20-08092026 tarball holds the same three files). `SHA256SUMS` pins them, and
`scripts/dev/deploy-tablet.sh` checks those pins before a release includes them.

**License:** XOVI is LGPL-3.0 (`LICENSE` here, from asivery/xovi). codrawer only loads it as a separate
library and does not modify it; codrawer's own extension (`../codrawer-layer`) is built separately.

To update: replace the three files from a new upstream release, regenerate `SHA256SUMS`
(`sha256sum xovi.so start stock > SHA256SUMS`), update the pins in `deploy-tablet.sh`, and test on
the device before adding the OS version to `boot/xovi-compat.conf`.
