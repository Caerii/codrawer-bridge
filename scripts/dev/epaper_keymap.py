"""Which characters can a keyboard type into xochitl? Read the answer out of xochitl's own keymaps.

**The problem.** The bridge types `/term` replies into the Paper Pro's focused text box through a
uinput keyboard (typer.rs, typer.go), choosing key codes from a US PC layout (keymap.rs,
`us_keymap`). On 2026-10-06 a careful baseline showed that `^ [ ] { } ` ~` never arrive. The
same is true of the user's own Bluetooth keyboard typing into xochitl, because the translation
from key code to character does not happen in the kernel, in xkb, or in the bridge: it happens in
reMarkable's Qt platform plugin.

**The facts this rests on** (read-only, `docs/investigations/keyboard-and-text.md`, section 2):

- xochitl runs on the `epaper` QPA plugin (`/usr/lib/plugins/platforms/libepaper.so`, the only
  platform plugin in `/proc/<pid>/maps`); no libxkbcommon is loaded and the tablet has no xkb data.
- libepaper.so carries its own fork of Qt's evdev keyboard handler (`EpaperEvdevKeyboardHandler`,
  `processKeycode`, `setInputFlavor`) with one static table per Type Folio language, exported as
  `EpaperEvdevKeyboardMap::Locale::<Country>::keymap` (United States, United Kingdom, Germany,
  France, Sweden, Norway, Denmark, Spain, Italy). xochitl picks the table from its
  `Settings.inputLocale` (the keyboard language in Settings).
- Each table is an array of 16-byte records: Qt's `QEvdevKeyboardMap::Mapping` with its last
  three fields widened, `u16 keycode, u16 unicode, u32 qtcode, u16 modifiers, u16 flags,
  u32 special` (read from the bytes: the dead-key flag sits at offset 10, the console-switch
  numbers 0x100.. at offset 12). `modifiers` uses Qt's evdev bits (1 Shift, 2 AltGr, 4 Ctrl, 8 Alt); `flags`
  has 1 = dead key, 2 = letter (Caps Lock applies), 4 = modifier, 8 = system (`special` is then a
  console switch or reboot request, as in Qt). `unicode` 0xffff means "no character".

**What it prints.** For each table, the printable ASCII characters that no plain or Shifted key
produces (what a US-PC typer cannot type into xochitl under that language), the dead keys (a key
that produces nothing by itself and changes the *next* character), and the key/modifier that
produces every ASCII character, so a typer can be generated from the table instead of assuming a
PC layout.

Usage (from the repo root; copy the plugin off the tablet first, read-only):

    scp root@192.168.50.156:/usr/lib/plugins/platforms/libepaper.so /tmp/
    uv run --with pyelftools python scripts/dev/epaper_keymap.py /tmp/libepaper.so [Locale] [--json]
    uv run --with pyelftools python scripts/dev/epaper_keymap.py /tmp/libepaper.so --typer \
        > bridge/remarkable/native/epaper_keymaps.json      # the bridge typer's tables (both engines)

Nothing here touches the tablet.
"""

from __future__ import annotations

import json
import string
import struct
import sys
from dataclasses import dataclass

from elftools.elf.elffile import ELFFile

# ── The record layout (see the module overview) ───────────────────────────────────────────────

RECORD = struct.Struct("<HHIHHI")
MOD_SHIFT, MOD_ALTGR, MOD_CTRL, MOD_ALT = 1, 2, 4, 8
FLAG_DEAD, FLAG_LETTER, FLAG_MODIFIER, FLAG_SYSTEM = 1, 2, 4, 8
NO_CHAR = 0xFFFF
PREFIX = "_ZN22EpaperEvdevKeyboardMap6Locale"


@dataclass(frozen=True)
class Mapping:
    """One row of a keymap: what `keycode` does while exactly `modifiers` are held."""

    keycode: int  # Linux input key code (KEY_*)
    unicode: int  # the character produced, NO_CHAR for none
    qtcode: int  # Qt::Key (dead keys are Qt::Key_Dead_*, 0x0100125x)
    modifiers: int  # MOD_* bits
    flags: int  # FLAG_* bits
    special: int  # system action when FLAG_SYSTEM

    @property
    def dead(self) -> bool:
        return bool(self.flags & FLAG_DEAD)


def _demangle_locale(sym: str) -> str:
    # _ZN22EpaperEvdevKeyboardMap6Locale12UnitedStates6keymapE -> UnitedStates
    rest = sym[len(PREFIX):]
    n = 0
    while rest[n].isdigit():
        n += 1
    return rest[n:n + int(rest[:n])]


def read_keymaps(path: str) -> dict[str, list[Mapping]]:
    """Every `EpaperEvdevKeyboardMap::Locale::*::keymap` table in the plugin, by locale name."""
    out: dict[str, list[Mapping]] = {}
    with open(path, "rb") as f:
        elf = ELFFile(f)
        loads = [s for s in elf.iter_segments() if s["p_type"] == "PT_LOAD"]

        def file_offset(vaddr: int) -> int:
            for s in loads:
                if s["p_vaddr"] <= vaddr < s["p_vaddr"] + s["p_filesz"]:
                    return vaddr - s["p_vaddr"] + s["p_offset"]
            raise ValueError(f"address {vaddr:#x} is not in a loaded segment")

        for sym in elf.get_section_by_name(".dynsym").iter_symbols():
            if not (sym.name.startswith(PREFIX) and sym.name.endswith("6keymapE")):
                continue
            if sym["st_size"] % RECORD.size:
                raise ValueError(f"{sym.name}: size {sym['st_size']} is not a multiple of {RECORD.size}")
            f.seek(file_offset(sym["st_value"]))
            data = f.read(sym["st_size"])
            out[_demangle_locale(sym.name)] = [Mapping(*RECORD.unpack_from(data, i)) for i in range(0, len(data), RECORD.size)]
    return out


# ── What a typer can produce from a table ────────────────────────────────────────────────────

PRINTABLE = [c for c in string.printable if c.isprintable()]  # ASCII 0x20..0x7e


def producers(table: list[Mapping]) -> dict[str, tuple[int, int]]:
    """Character → (keycode, modifiers) for every character a non-dead key produces with no
    modifier, Shift, or AltGr(+Shift). Ctrl/Alt rows are shortcuts, not text, and are skipped.
    The first row wins, as in the handler's linear search."""
    got: dict[str, tuple[int, int]] = {}
    for m in table:
        if m.dead or m.unicode == NO_CHAR or m.modifiers & (MOD_CTRL | MOD_ALT):
            continue
        got.setdefault(chr(m.unicode), (m.keycode, m.modifiers))
    return got


def report(name: str, table: list[Mapping]) -> dict:
    prod = producers(table)
    missing = [c for c in PRINTABLE if c not in prod]
    dead = [
        {"keycode": m.keycode, "mods": m.modifiers, "unicode": f"U+{m.unicode:04X}", "qtcode": f"{m.qtcode:#010x}"}
        for m in table
        if m.dead
    ]
    system = sorted({(m.keycode, m.modifiers, m.special) for m in table if m.flags & FLAG_SYSTEM})
    return {
        "locale": name,
        "rows": len(table),
        "ascii_missing": "".join(missing),
        "dead_keys": dead,
        "system_chords": [{"keycode": k, "mods": md, "special": f"{sp:#06x}"} for k, md, sp in system],
        "ascii_producers": {c: list(prod[c]) for c in PRINTABLE if c in prod},
    }


def typer_tables(maps: dict[str, list[Mapping]]) -> dict:
    """The bridge typer's tables (`--typer`): per locale, the characters it can produce with the
    key and modifiers (Shift 1, AltGr 2) that produce them, and the printable ASCII it cannot.
    Written to bridge/remarkable/native/epaper_keymaps.json, which both engines embed."""
    keypad = set(range(71, 84)) | {96, 98}  # KEY_KP7..KP_DOT, KPENTER, KPSLASH: NumLock-dependent
    out = {}
    for name in sorted(maps):
        prod = producers(maps[name])
        # A character the table also produces from a main-keyboard key uses that key, never the
        # keypad (France's digits are first in its table on the keypad).
        main = producers([m for m in maps[name] if m.keycode not in keypad])
        prod = {c: main.get(c, km) for c, km in prod.items()}
        out[name] = {
            "missing": "".join(c for c in PRINTABLE if c not in prod),
            "keys": {c: [k, m] for c, (k, m) in sorted(prod.items()) if c.isprintable()},
        }
    return out


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    if "--typer" in argv:
        args = [a for a in argv[1:] if a != "--typer"]
        print(json.dumps(typer_tables(read_keymaps(args[0])), ensure_ascii=False, separators=(",", ":")))
        return 0
    as_json = "--json" in argv
    args = [a for a in argv[1:] if a != "--json"]
    maps = read_keymaps(args[0])
    wanted = args[1:] or sorted(maps)
    reports = [report(n, maps[n]) for n in wanted]
    if as_json:
        print(json.dumps(reports, indent=1, ensure_ascii=False))
        return 0
    for r in reports:
        dead = ", ".join(f"key {d['keycode']}{'+Shift' if d['mods'] & MOD_SHIFT else ''}→{d['unicode']}" for d in r["dead_keys"])
        print(f"{r['locale']:<14} rows={r['rows']:<4} ASCII it cannot type: {r['ascii_missing'] or '(none)'}")
        print(f"{'':<14} dead keys: {dead or '(none)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
