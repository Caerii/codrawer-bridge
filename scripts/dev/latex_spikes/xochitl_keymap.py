"""
Decode the physical-keyboard keymaps compiled into xochitl's e-paper platform plugin.

**The problem.** Text typed into xochitl through a virtual US keyboard (the bridge's uinput typer,
ADR 005) loses ``^ [ ] { } \\ ~`` while letters, digits and most punctuation arrive. LaTeX source
is made of exactly those characters, so before designing an editor we need to know where they go.

**The facts it rests on.** xochitl does not use Qt's stock evdev keyboard plugin: its platform
plugin ``/usr/lib/plugins/platforms/libepaper.so`` (mapped into xochitl, see
``docs/investigations/latex-on-tablet.md``) carries ``EpaperEvdevKeyboardHandler`` and one static
table per locale, exported as ``EpaperEvdevKeyboardMap::Locale::<Country>::keymap``. Its log
strings say how the table is chosen: the Type Folio's firmware language, else the ``InputLocale``
Qt setting, else "No keymap set by QT settings or firmware, defaulting to US." Each entry is
16 bytes, a widened Qt ``QEvdevKeyboardMap::Mapping``:

    u16 keycode  u16 unicode  u32 qtcode  u8 modifiers  u8 pad  u16 flags  u32 special

``modifiers`` is Qt's evdev set (1 Shift, 2 AltGr, 4 Control, 8 Alt); ``flags`` bit 0 is
``IsDead``: the key starts a compose sequence instead of producing a character.

**How to run.** Copy the plugin off the tablet read-only, then::

    scp root@<tablet>:/usr/lib/plugins/platforms/libepaper.so .
    uv run --with pyelftools python scripts/dev/latex_spikes/xochitl_keymap.py libepaper.so

It prints, per locale, which key (``kc<code>/m<modifiers>``) yields each LaTeX-critical character,
``/DEAD`` when only as a dead key, and ``-`` when no key yields it at all.
"""

from __future__ import annotations

import struct
import sys

from elftools.elf.elffile import ELFFile

# The characters LaTeX source needs that a stock US layout types with Shift or plain keys.
LATEX_CHARS = "[]{}~^`" + chr(92)
# Combining marks a dead key carries for the spacing characters above (circumflex, tilde, grave).
DEAD_FOR = {0x302: "^", 0x303: "~", 0x300: "`"}
# Keypad and SysRq keys: never used by the typer (uinput.go, isKeypad).
SKIP_CODES = {55, 74, 78, 83, 98, 99}


def tables(elf: ELFFile):
    """Yield (locale, raw bytes) for every exported keymap table."""
    def file_off(addr: int) -> int:
        for seg in elf.iter_segments():
            if seg["p_type"] == "PT_LOAD" and seg["p_vaddr"] <= addr < seg["p_vaddr"] + seg["p_filesz"]:
                return addr - seg["p_vaddr"] + seg["p_offset"]
        raise ValueError(hex(addr))

    for sym in elf.get_section_by_name(".dynsym").iter_symbols():
        if sym.name.startswith("_ZN22EpaperEvdevKeyboardMap6Locale") and sym.name.endswith("6keymapE"):
            elf.stream.seek(file_off(sym["st_value"]))
            locale = sym.name[len("_ZN22EpaperEvdevKeyboardMap6Locale"):-len("6keymapE")].lstrip("0123456789")
            yield locale, elf.stream.read(sym["st_size"])


def producers(raw: bytes) -> dict[str, list[str]]:
    """Map each LaTeX-critical character to the keys that produce it in one table."""
    out: dict[str, list[str]] = {c: [] for c in LATEX_CHARS}
    for i in range(0, len(raw), 16):
        code, uni, _qt, mods, _pad, flags, _special = struct.unpack_from("<HHIBBHI", raw, i)
        if code in SKIP_CODES:
            continue
        dead = "/DEAD" if flags & 1 else ""
        if uni < 0x10000 and chr(uni) in out:
            out[chr(uni)].append(f"kc{code}/m{mods:x}{dead}")
        elif dead and uni in DEAD_FOR:
            out[DEAD_FOR[uni]].append(f"kc{code}/m{mods:x}{dead}")
    return out


def main(path: str) -> None:
    with open(path, "rb") as f:
        for locale, raw in tables(ELFFile(f)):
            row = "  ".join(f"{c}:{','.join(v) or '-'}" for c, v in producers(raw).items())
            print(f"{locale:<14} {len(raw) // 16:3d} keys  {row}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "libepaper.so")
