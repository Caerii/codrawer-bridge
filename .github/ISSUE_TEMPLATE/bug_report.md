---
name: Bug report
about: Something does not work as the docs say it should
labels: bug
---

<!-- Security problems: please use private reporting instead (SECURITY.md). -->

## What happened

<!-- What you did, what you expected, what you saw instead. -->

## How to reproduce

1.
2.
3.

## Setup

- **Component**: <!-- tablet bridge / boot & install / glasses app / phone or browser / desktop router / iPad -->
- **`boot.sh doctor` output** (tablet OS version, release, engine, services, health):

  ```
  # ssh root@<tablet-ip> sh /home/root/codrawer/current/boot.sh doctor
  ```

- **Engine**: <!-- go or rust (ENGINE in /home/root/codrawer/bridge.env) -->
- **Glasses**: <!-- Even G2 firmware version, Even app version, phone model and OS; or "not used" -->
- **How the app was opened**: <!-- dev server + QR, packaged .ehpk, simulator, plain browser -->
- **codrawer commit or release**: <!-- git rev-parse --short HEAD, or the release from doctor -->

## Logs

<details><summary>Bridge log</summary>

```
# ssh root@<tablet-ip> journalctl -u codrawer-bridge -n 200 --no-pager
```

</details>

<!-- Also useful when relevant: journalctl -u codrawer-bluetooth (keyboard), the phone app's
console, .codrawer/logs/ on the desktop. Remove pairing codes and addresses you consider private. -->
