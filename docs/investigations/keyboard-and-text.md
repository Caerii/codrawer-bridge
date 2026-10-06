# Keyboard and text on the Paper Pro (2026-10-06)

Status: research and design. Off-device spikes only; on the tablet, read-only `ssh`/`scp`
(`/proc/<xochitl>/maps`, `/proc/bus/input/devices`, the journal, a copy of the QPA plugin).
Nothing was installed, restarted or written on the tablet.

The question: how codrawer should put text into, take text out of, and take commands from the
reMarkable Paper Pro's text boxes, given a Bluetooth keyboard (the Pebble K380s) that both
xochitl and the bridge read, and the codrawer-layer XOVI extension running inside xochitl.
Related: ADR 005 (reply sinks, the virtual keyboard), ADR 003 (agent ink is governed), ADR 010
and `docs/protocol.md` § `primer` (the Primer and its learner), `native-multiplayer-layer.md`
(the extension, its meta-call pattern), `keyboard-latency.md` (the key path and the typer).

Device: OS `3.29.0.149` (Codex `6.0.105`), xochitl on Qt `6.10.3`, platform plugin
`/usr/lib/plugins/platforms/libepaper.so`, language `en_US.UTF-8`.

## Recommendation

1. **Insert text through xochitl's own `SceneController`, not through keys.** Its meta-object (dumped
   on this device by codrawer-layer on 2026-10-06) has a complete, QString-typed text API:
   `replaceText(QString[, start, length, cursor, flags])`, `cycleParagraphStyle(Type)`,
   `setTextStyle(Bold|Italic)`, `setCursorIndex`, `moveCursor`, `selectTextRange`,
   `focusRootDocument`, `createRootDocument`, `undo`, with read-back properties
   (`rootDocumentLength`, `textCursorIndex`, `textParagraphStyle`, `textStyles`). Every one is
   what xochitl's own QML calls. It accepts any Unicode, skips the keymap entirely, can make
   a reply one undo step, and sets native heading/bullet/checkbox styles.
2. **The dropped characters are a keymap fact.** No setting fixes them all. xochitl translates
   keys with its own static Type Folio tables inside `libepaper.so`, not xkb. The "United
   States" table has **no key at all** for ``[ ] { } ^ ` ~``, and the keys a PC layout uses for
   five of them are **dead keys**, so they also corrupt the next character. Under "United
   Kingdom", only ``^ ` ~`` are missing. The uinput typer therefore stays a fallback: it should
   strip or substitute those characters, wait until the pen and the hand are off the screen,
   and settle after Enter.
3. **The lost start of a reply is most likely xochitl's guard against accidental typing.** It
   ignores every key while the pen is "close" or a touch is in progress (`DeviceSceneView`
   QML). A leading dash is not the cause: autoformat fires only on a single `-`, `*` or `+`
   followed by a space. The typer should hold while the pen is in range or a touch is down.
   The bridge already reads both devices.
4. **One keyboard, two consumers.** The keyboard's state should be explicit and owned by the
   extension: an application-level Qt event filter inside xochitl, with no EVIOCGRAB. Today
   **Escape**, which the glasses HUD uses to clear its input line, also *closes the open
   notebook* in xochitl (`CloseShortcut`: Escape and Ctrl+W). Fix that first.

Phase 1 is direct insertion with read-back verification, plus the fallback fixes (pen-clear
gate, Enter settle, character filter) and the Escape conflict. Phase 2 is chords, the Ctrl+K
palette, `@`/`#` completions and snippets. Phase 3 is the editor panel, dictation and page-text
context. The table is in § 10, the plan in § 11.

A parallel WIP (local branch `feat/native-agent-ink`, uncommitted) already adds
`{"op":"text_insert"}`/`text_read` on `/run/codrawer/ink.sock`. It inserts through a
`QInputMethodEvent` and a Return key event. Section 1 keeps its wire format and adds the
SceneController route, styles, undo grouping, focus handling and read-back verification.

---

## 0. Facts this rests on

| Fact | Evidence |
| --- | --- |
| xochitl's text boxes are one **root document** per page ("seabird mode"), edited through `SceneController`, focused via the page's `SceneView` | extracted QML: `DocumentView.enterTextMode` → `sceneController.createRootDocument(ParagraphStyle.Type.Title)`, `focusRootDocument(point)`, `sceneView.textModeEnabled = true` |
| `SceneController` exposes `replaceText`(5 overloads), `setPreeditText`, `replaceComposeText`, `begin/endInputMethodTransaction`, `pasteText`/`pasteClipboardContent(SceneClipboardText, PasteMode, MergeActionMode)`, `keyAction(SceneKeyHandlerAction, flags)`, `cycleParagraphStyle`, `setParagraphStyle`, `indent/unindentParagraph`, `setTextStyle`, `setCursorIndex/Position`, `moveCursor`, `selectText`, `selectTextRange`, `deleteText`, `copy/cutSelectedText`, `toggleCheckboxByIndex`, `undo`/`redo` | **on-device** meta dump (codrawer-layer `dump`, journal 2026-10-06 04:12, slots #114–#176); signatures also in the binary's mangled lambda names |
| Read-only properties: `textDocumentId`, `textCursorIndex`, `textCursorPosition` (scene px), `textParagraphStyle`, `textStyles`, `textSelectionStyles`, `textParagraphBounds`, `hasTextSelection`, `rootDocumentLength`, `rootDocumentBoundingRect`, `isTextCursorNewline`, `keyActionRunning`, `undoAvailable` | same dump (props #8–#45) |
| Styles: `ParagraphStyle::Type` = Title, Subheading, Subheading2, Paragraph, Bulletpoint(Indented), NumberedList(Indented), CheckboxUnchecked/Checked(+Indented), ImageBlock; `CharacterStyle::Type` = None, Bold, Italic, Link | binary meta-strings; `FormatMenuDelegate` QML lists the seven toolbar styles |
| Autoformat in the key path: a paragraph whose first word is exactly `-`, `*` or `+` becomes a bullet when a space follows (`word before space:` + regex `^[\*\+\-]$` → `bulletpoint match`); also `checkbox match`, `numbered list match`, `link match` | binary strings near the text handler's log lines |
| Text handler log lines: `handleKeyStroke: no document focused`, `handleKeyEnter: no document focused`, `pasteText: no document focused`, `setParagraphStyle: no document focused` | binary strings (`rm.sceneparticipant` category) |
| Key → character happens in `libepaper.so` (`EpaperEvdevKeyboardHandler::processKeycode`) with static tables `EpaperEvdevKeyboardMap::Locale::{UnitedStates,UnitedKingdom,Germany,France,Sweden,Norway,Denmark,Spain,Italy}::keymap`; no libxkbcommon is mapped, no `/usr/share/X11/xkb` | `/proc/336/maps` (only `libepaper.so` under `plugins/platforms`), plugin dynsym, `scripts/dev/epaper_keymap.py` |
| Keys are ignored while the pen is close or a touch is active: `Connections { target: root.sceneView; enabled: Qt.inputMethod.visible \|\| !PenClosenessMonitor.penClose; onSceneKeyActionReceived: if (sceneViewGestures.userIsActive) return; … }` with the comment "When writing using Seabird, any keyboard presses are considered accidental so we block it when the pen is close" | extracted `DeviceSceneView` QML |
| Escape and Ctrl+W close the open document; Ctrl+1…7 set the paragraph styles (Alt on the Apple flavour) | extracted `CloseShortcut`, `DocumentViewShortcuts`, `ShortcutCheatSheet` QML |
| The on-screen keyboard is hidden whenever a hardware keyboard counts as connected (`keyboardContainer.visible: !root.keyboardConnected`) | the on-screen keyboard's layout QML (the item with `required property VirtualKeyboard virtualKeyboard`); the bridge's uinput device registers with the `kbd` handler (`/proc/bus/input/devices`: `codrawer virtual keyboard`, `Handlers=kbd event4`) |
| Fonts on the device: Noto Sans (+ Mono, JP, KR, SC, Arabic, Hebrew, Devanagari, Thai, Lao), EB Garamond; no maths font | `ls /usr/share/fonts/ttf/*` |
| Even Hub SDK 0.0.16 has a microphone: `bridge.audioControl(isOpen, AudioInputSource.Glasses \| Phone)`, frames arrive as `audioEvent { audioPcm: Uint8Array, source, direction, speakerRole }`; PCM format undocumented | `node_modules/@evenrealities/even_hub_sdk` README and `index.d.ts` |

Scratch (not committed): the session scratchpad `xovi-research/` (binary, 517 extracted QML
files, strings) and `kbd/` (the plugin copy, keymap dumps, the journal's meta dumps).

---

## 1. Direct text insertion through the extension (the core)

### 1.1 How xochitl's text boxes are built

A notebook page has at most one **root document**, a CRDT text that flows down the page
(`rootDocumentTextWidth`, `rootDocumentBoundingRect`). It is the page's `RootText` block in the
`.rm` v6 file: rmscene's `RootTextBlock`, a `CrdtSequence` of text items with paragraph styles
in a last-writer-wins map keyed by character ids. Our parsers
(`rust/src/rmlines/mod.rs`, `native/rmlines/parse.go`) currently **skip** block `0x07`. xochitl
calls the editing state "seabird mode" (`sceneView.textModeEnabled`):

- **Entering it.** `DocumentView.enterTextMode(requestFocus, cursorPosition)` creates the root
  document if there is none (with style **Title**), then calls
  `sceneController.focusRootDocument(point)`, sets `textModeEnabled = true` and gives the
  `SceneView` active focus. It runs when a keyboard connects to an empty page, on a double tap,
  and on the first key while not in text mode (`requestTextMode`).
- **Leaving it.** With a keyboard connected, any pen stroke leaves text mode ("If not in HWC
  mode, exit text mode when using the pen. Will be re-enabled when using the keyboard"). So
  after the user inks a turn, the next key re-enters text mode.
- **The focus item.** The window's `activeFocusItem` is the page's `SceneView` (a C++
  `QQuickItem` with `inputMethodHints: Qt.ImhMultiLine | Qt.ImhNoTextHandles`). It is not a
  `TextEdit`. Its `keyHandler` (`SceneKeyHandler`, flavour Apple or Windows) turns key events into
  `SceneKeyHandlerAction`s: KeyStroke, CursorMove, Enter, LineBreak, Backspace, Delete*,
  SelectAll, PageUp/Down, Undo, Redo, Copy, Paste, PasteAndMatchStyle, SelectionToolToggle,
  Indent, Unindent, the seven style actions, Bold, Italic. The QML forwards each action to
  `controller.keyAction(action, flags)`, behind the gate in § 0. Input-method commits arrive
  through the item's `inputMethodEvent` (`SceneView.textCommitted`;
  `SceneController.commitInputMethod`, `inputMethodUpdateNeeded`).
- **Formatting** goes through the same controller. The toolbar's format menu calls
  `cycleParagraphStyle(style)` and `indentParagraph()`. The bold and italic buttons call
  `setTextStyle(TextFormatting.TextStyle.Bold)` and the italic equivalent. The checkbox glyph
  calls `toggleCheckboxByIndex(i)`. Paste is
  `pasteClipboardContent(Clipboard.text, SceneController.KeepStyle|MatchStyle)`. Handwriting
  conversion inserts with
  `pasteText(Clipboard.text, KeepStyle, MergeWithPreviousAction)` (the merge mode makes it part of
  the previous undo step).
- **The on-screen keyboard** (`xofm.modules.virtualkeyboard.VirtualKeyboard`) inserts with
  `insertText(text, replaceFrom, replaceLength)`, an input-method commit, so an in-process text
  path is the supported one.

### 1.2 Routes into the root document

| Route | What it is | Keymap? | Passes the QML key gate? | Styles | Undo | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **A. `SceneController.replaceText`** | invoke the slot by name on the GUI thread (inkling's meta-call pattern, already in `main.cpp`'s `invoke`) | no | **not involved** (direct call; the gate only wraps `onSceneKeyActionReceived`) | with `cycleParagraphStyle` / `setTextStyle` | `ReplaceFlags` has `MergeWithSubsequentReplace`; `begin/endInputMethodTransaction` | **primary** |
| B. `QInputMethodEvent` commit to the focus item | what the WIP does; what an IME or the VKB does | no | to verify (the commit may reach the controller in C++ without the QML handler) | none by itself | the item's own | second route; the WIP's |
| C. `pasteText(SceneClipboardText, …)` | the clipboard path, splits paragraphs (`insert text container: paragraphs=`) | no | not involved | KeepStyle/MatchStyle | `MergeWithPreviousAction` | only if `QString → SceneClipboardText` converts (probe T0) |
| D. uinput keystrokes | today's typer | **yes** (seven characters impossible) | **yes** (dropped while pen close or touch) | autoformat only | one step per key | fallback |
| E. `keyAction(SceneKeyHandlerAction)` | synthesize actions in-process | no | not involved | the style actions | per action | for Enter/Indent only, if the gadget is constructible (T0) |

Route A works without the user's cooperation. The pen can be hovering and the hand can be on
the glass. It needs a *focused* root document (otherwise the controller logs `… no document
focused` and does nothing), so the extension ensures focus first (§ 1.3).

### 1.3 Insert, format, verify (the extension's job, one GUI-thread job per operation)

```
ensureFocus():
  page = the visible DocumentView's controller            (findOpenPage, as `stroke` does)
  if expect_page given and page.pageId != expect_page → err page_changed
  if !controller.hasRootDocument → controller.createRootDocument(Paragraph)   # not Title
  if controller.textDocumentId is null → controller.focusRootDocument()       # keeps the cursor
  (no textModeEnabled change unless asked: insertion does not need the visual text mode)

insert(blocks, undo="one"):
  len0 = rootDocumentLength; cur0 = textCursorIndex
  beginInputMethodTransaction()                          # T4: does this group undo?
  for i, b in blocks:
    if i > 0: replaceText("\n")                          # T2: paragraph break; else keyAction(Enter)
    if b.style != current style: cycleParagraphStyle(Type(b.style))   # only when it differs: cycle toggles
    replaceText(b.text, 0, 0, len(b.text), i>0 ? MergeWithSubsequentReplace : 0)
    for r in b.bold/italic: selectTextRange(start+r0, start+r1); setTextStyle(Bold|Italic); setCursorIndex(end)
  endInputMethodTransaction()
  verify: rootDocumentLength == len0 + inserted, textCursorIndex == cur0 + inserted
  reply ok … len=len0->len1 or err verify_failed (and log), never "ok" unverified
```

- **Cursor.** Text goes in at the user's cursor (`textCursorIndex`), as typing would. `cursor:
  "end"` moves to the end first (`moveCursor(End)`, MoveOperation 11) for agent replies that must
  not land mid-sentence. After insertion the cursor sits after the text, so the user keeps
  typing.
- **Styles.** `cycleParagraphStyle` toggles. Pressing Bullet on a bullet paragraph makes it
  body text, as the toolbar does. The extension therefore reads `textParagraphStyle` first and
  only cycles when the style differs. `TextFormattingUtils.isFormattingButtonSelected`
  is xochitl's own comparison. `setParagraphStyle(scene::ParagraphStyle)` sets a style without
  toggling but needs a `scene::ParagraphStyle` gadget value; T3 checks whether one can be
  built.
- **Undo.** A reply should be one undo step, as handwriting conversion is (`pasteText(…,
  MergeWithPreviousAction)`). Candidates, in order: the input-method transaction pair;
  `ReplaceFlag::MergeWithSubsequentReplace` on every replace after the first; route C's
  `MergeWithPreviousAction`. T4 picks the one that works.
- **Read-back is the contract.** Route B (and D) can be swallowed silently; `rootDocumentLength`
  and `textCursorIndex` are cheap properties, so every insert is verified and the reply says so.
- **Autoformat.** Route A does not pass through `handleKeyStroke`, so `- ` should stay a literal
  dash (T5 checks). Markdown is mapped explicitly instead (`scripts/dev/textplan.py`).
- **The bridge's uinput device can go.** While it exists, xochitl counts a keyboard as
  connected and hides its on-screen keyboard (§ 0). With route A available, the bridge creates
  the virtual keyboard only when it actually falls back.

### 1.4 The socket messages (bridge ⇄ codrawer-layer, `/run/codrawer/ink.sock`)

The WIP's lines stay valid: `{"op":"text_insert","id":"t3","text":"…"}` means body
paragraphs split at `\n`. The new fields are optional, and the extension's `hello` names what
it supports:
`hello codrawer-layer ink text_insert text_read text_style text_focus text_watch chord`.

```jsonc
// bridge → extension
{"op":"text_insert","id":"t3",
 "blocks":[{"style":"h1","text":"Lemma 2"},
           {"style":"body","text":"Let n be odd.","bold":[[4,5]],"italic":[]},
           {"style":"bullet","text":"case 1","indent":1}],   // or "text":"…" (body, \n-split)
 "cursor":"here|end",          // default here
 "undo":"one|each",            // default one
 "route":"auto|scene|im",      // auto: scene, then im; never keys (the bridge owns that fallback)
 "expect_page":"<uuid>",       // refuse if the visible page changed since the request
 "source":"term|dictation|snippet|completion|agent"}          // logged; for the glasses' status
{"op":"text_read","id":"t4","scope":"cursor|paragraph|selection"}
{"op":"text_style","id":"t5","paragraph":"checkbox","char":"bold"}   // apply at the cursor/selection
{"op":"text_focus","id":"t6","mode":"text|end|point","x":-200,"y":900}   // enter text mode, move the cursor
{"op":"text_watch","id":"t7","on":true,"what":["cursor","token"]}       // events below, rate-limited

// extension → bridge (replies are one line, as the WIP)
ok t3 text_insert 42 via=scene len=118->160 undo=one
err t3 no_root_document|page_changed|verify_failed|not_text_page|busy
text t4 {"scope":"paragraph","text":"Let n be odd.","cursor":4,"style":"body","bold":false,"page":"<uuid>"}
// unsolicited events (JSON with "t", like dock_action)
{"t":"text_cursor","page":"<uuid>","index":160,"para_style":"body","token":"@pri","x":-210,"y":1140}
{"t":"chord","chord":"ctrl+k","page":"<uuid>","state":"page"}
```

- `text_read` uses the page's `SceneView` input-method query (`Qt::ImSurroundingText`,
  `ImCursorPosition`, `ImCurrentSelection`), as the WIP does. Qt items usually answer it with the
  current paragraph. That avoids `selectText`/`copySelectedText`, which would clobber the user's
  selection and clipboard. A whole page's text comes from the saved `.rm` (§ 7).
- Limits: as the WIP, 16 384 characters per insert; one operation at a time (`busy` otherwise);
  each operation is one GUI-thread job well inside xochitl's 60 s watchdog.
- Safety: insert only into the visible page's root document; never call `clearRootDocument`,
  `deleteText` outside text the same operation inserted, or anything on other pages.

### 1.5 Router protocol additions (WebSocket, `docs/protocol.md`)

| Message | Direction | Purpose |
| --- | --- | --- |
| `{"t":"text_insert","id":"x1","source":"term","blocks":[…]\|"text":"…","cursor":"end","turn":12}` | router/client → the turn owner's tablet bridge (ADR 005: only the owner's tablet) | put text on the page; `term` replies with sink `tablet` become this in the router instead of the bridge's typer |
| `{"t":"text_result","id":"x1","ok":true,"via":"scene\|im\|keys","chars":160,"dropped":{"[":2}}` | bridge → router → clients | the glasses show *typed into tablet* / what the fallback dropped |
| `{"t":"text_request","scope":"paragraph\|page"}` and `{"t":"text_context","scope":…,"text":"…","cursor":4,"style":"body","page":"<uuid>"}` | client/agent → bridge; bridge → router | reading text as context, only with consent (§ 7) |
| `{"t":"chord","chord":"ctrl+enter","source":"tablet"}` | bridge → router → clients | a codrawer chord the tablet intercepted (§ 3); `key` messages for that keystroke carry `"consumed":true` |
| `{"t":"complete_index","owner":"primer","kind":"#","items":[{"id":"pigeonhole","label":"Pigeonhole principle","insert":"#pigeonhole","hint":"…"}]}` | router → bridge (like `dock_entries`) | the completion popup's data (§ 4), merged per owner into `/run/codrawer/complete.json` |
| `{"t":"snippets","items":[{"trigger":"thm","md":"## Theorem.\n$0"}]}` | router → bridge | the user's snippet set (§ 5), synced from the desktop |
| `{"t":"dictation","state":"start\|stop","source":"glasses\|phone"}` (+ audio frames) | app → router | dictation (§ 8); the router answers with `text_insert` (`source:"dictation"`) |

### 1.6 The fallback ladder

```
text for the tablet
  ├─ extension connected and hello lists text_insert ─▶ route A (scene) ─▶ verify ─▶ ok
  │                                                   └▶ route B (im)   ─▶ verify ─▶ ok
  │                                                   └▶ err ─────────────────────┐
  └─ no extension (XOVI off, OS not in compat.conf, extension crashed) ───────────┤
                                                                                  ▼
     uinput typer, hardened (§ 2.4): pen/touch-clear gate, Enter settle, per-locale keymap,
     untypeable characters removed or substituted and reported in text_result.dropped
```

The bridge decides per operation. The extension never falls back to keys itself, so a failure
is visible and nothing is typed twice.

### 1.7 Probes to run on the device (later, with the user's go-ahead; not done here)

All on a scratch notebook page named in the command (`page=<uuid>`, as `stroke` requires).
Each is a new extension command logged to `/tmp/codrawer-layer/log`.

- **T0 (read-only):** dump the focus item's class and meta-object, its `inputMethodQuery`
  answers, `SceneKeyHandler` and the `SceneKeyHandlerAction` gadget (is `type` writable?),
  `scene::ParagraphStyle` (constructible? writable `type`?), and
  `QMetaType::canConvert(QString → SceneClipboardText)`.
- **T1:** `replaceText("probe")`: length +5, cursor +5, `undoAvailable`; then `undo()` restores
  the length.
- **T2:** `replaceText("a\nb")`: two paragraphs? (`isTextCursorNewline`, `textParagraphStyle`, `.rm`
  RootText after the save.)
- **T3:** `cycleParagraphStyle(Bulletpoint)` twice (toggles?), `setTextStyle(Bold)` on a
  `selectTextRange`.
- **T4:** three inserts inside `begin/endInputMethodTransaction`, and with
  `MergeWithSubsequentReplace`: does one `undo()` remove all three?
- **T5:** `replaceText("- x")`: a literal dash, or a bullet?
- **T6:** T1 while the pen hovers and while a finger rests on the glass: does route A still
  insert? Does route B?
- **T7 (diagnosis for § 2.2):** spy on `keyActionRunningChanged`, `rootDocumentLengthChanged`,
  `textDocumentIdChanged` and the view's `textModeEnabled` while the uinput typer types
  `--- careful ---\nThe` right after a pen stroke, with the pen held near and then away.

---

## 2. Why characters drop with uinput, and fixes for the fallback

### 2.1 The keymap

xochitl's platform plugin carries one table per Type Folio language. `epaper_keymap.py` reads
them out of the plugin. The ASCII that no plain or Shifted key produces:

| xochitl keyboard language | ASCII it cannot type | dead keys (key code → combining mark) |
| --- | --- | --- |
| United States | ``[ ] ^ ` { } ~`` | 7+Shift → ̂ (U+0302), 26 → ´ (U+00B4), 26+Shift → U+0060, 27 → ̈ (U+0308), 27+Shift → ̃ (U+0303) |
| United Kingdom | ``^ ` ~`` | 7+Shift → ̂, 41+Shift → ̃ |
| Germany, Sweden, Norway, Denmark, Spain, Italy | ``[ ] ^ ` { } ~`` | various (13, 27, 53, …) |
| France | ``% [ ] ^ ` { } ~`` | 3, 26, 26+Shift, 41 |

This matches the baseline exactly. The typer (keymap.rs `us_keymap`) sends `[` as key 26,
`]` as 27, `{`/`}` as Shift+26/27, `^` as Shift+7 and `` ` ``/`~` as key 41 and Shift+41. Under the US table
26 and 27 are dead accents, Shift+7 is a dead circumflex and 41 has no mapping at all. A dead key
emits nothing and waits to combine with the next key. Depending on the plugin's compose table
(not exported; Qt's default composes `´`+`a` → `á`), it also changes the character after it. So
the damage can reach past the missing character: `a[i]` may come out as `aí` or `ai`. `\` and
`|` are fine (key 43). The user's own Pebble has the same limits when typing into xochitl;
xochitl's answer is its symbol popup (Ctrl+Alt+Space).

The `UnitedStates` table appears to describe the US Type Folio, a reduced keyboard, not a PC layout. Ctrl+Alt+F1…F12,
Ctrl+Alt+←/→ and Ctrl+Alt+Del are console-switch/reboot specials in the table, so codrawer must
never bind those chords.

### 2.2 The lost start of a reply

Measured: `--- careful ---`, the newline and the first `T` were lost, then everything arrived.
From the QML and strings, the candidates in order of likelihood:

1. **Pen or touch gate.** While `PenClosenessMonitor.penClose`, the handler that forwards keys is
   disabled outright. While `sceneViewGestures.userIsActive` (a touch candidate or an active
   touch filter), keys are returned unhandled. A reply starts right after the user inked the
   turn and pressed Enter, which is exactly when the pen is near and a hand may rest on the
   glass. At 12 ms per key, 17 keystrokes is about 200 ms of "pen still close". This explains
   a lost *prefix* followed by clean text.
2. **Re-entering text mode.** The turn's ink left text mode (§ 1.1). The first key re-enters it,
   and on an empty page creates the root document as **Title**. Enter on an empty root document
   is dropped by design (`if (!controller.rootDocumentLength) { requestTextMode(); return; }`).
   This loses one key, not seventeen. It is not the whole story.
3. **Busy scene.** `keyActionRunning` exists, so key actions are queued jobs. Nothing in the QML
   drops keys while it is true, but the C++ might. T7 settles this.
4. **Autoformat: ruled out for `---`.** The bullet rule needs the first word to be exactly
   one `-`, `*` or `+` before a space. A leading `- ` or `* ` *does* become a native bullet
   with the dash removed, which is worth knowing for markdown replies on the key path.

### 2.3 What the user sees today, beyond the measurement

- Every HUD keystroke typed on the Pebble also lands in the notebook when xochitl is in text mode
  (no grab), and Escape (HUD: clear the line) closes the notebook. § 3 fixes both.
- The on-screen keyboard never appears while the bridge's virtual keyboard exists (§ 0).

### 2.4 Fixes for the fallback typer (bridge-side, small)

| Fix | Where | Detail |
| --- | --- | --- |
| **Character filter** | `typer.rs`/`typer.go` (`textplan.py` `fallback_text` is the prototype) | never send a dead-key or unmapped keystroke. Remove the locale's missing characters (default), or substitute (`TYPE_SUBSTITUTE=1`: `[`→`(`, `^`→`**`, …). Report them in `text_result.dropped` so the glasses say "2 characters not typeable; full text on glasses" |
| **Per-locale keymap** | `keymap.rs`/`keyboard.go` | generate the typer's char → (code, mods) table from xochitl's own tables (`epaper_keymap.py --json`), selected by the tablet's keyboard language. Under UK, `[ ] { }` become typeable. The same table should translate the Pebble's keys for the glasses, so page and glasses agree |
| **Pen/touch-clear gate** | typer + pen reader (`linux.rs`, `pen_stream.go`) | hold typing while the pen is in range (BTN_TOOL_PEN down on event2) or a touch is down (event3), and for 300 ms after both clear. Resume where it stopped. This also helps route B if T6 shows it is gated |
| **Prime text mode** | typer | before the first key of a reply, send End (a CursorMove: it re-enters text mode without changing text) and wait 150 ms |
| **Enter settle** | typer | after Enter, wait `TYPE_ENTER_MS` (start at 60 ms; T7 decides) before the next key |
| **Esc no longer stops typing** | ADR 005 | Escape closes the notebook (§ 3). Stop a reply with the ring tap or Ctrl+. (§ 3.2) |

---

## 3. Keyboard shortcuts: one keyboard, two consumers

### 3.1 What xochitl already binds

From the QML (`DocumentViewShortcuts`, `CloseShortcut`, the library's create button,
`ShortcutCheatSheet`, `DocumentView.Keys.onPressed`) and the QPA keymap. "Ctrl" means the
Windows flavour; under the Apple flavour Alt plays Ctrl's role:

| Chord | xochitl action | Context |
| --- | --- | --- |
| Escape, Ctrl+W | **close the document** (or leave refine mode) | document open, no sub-dialog |
| Ctrl+1 … Ctrl+7 | Title, Subheading 1, Subheading 2, Body, Bullets, Numbered, Checkbox | text mode |
| Ctrl+X/C/V, Ctrl+Shift+V, Ctrl+A, Ctrl+Z, Ctrl+Y | cut, copy, paste, paste unformatted, select all, undo, redo | text mode (Ctrl+V/Z/Y also outside it) |
| Ctrl+B, Ctrl+I | bold, italic: the `BoldStyle`/`ItalicStyle` actions exist; the binding is inferred (not on the cheat sheet) | text mode |
| Tab, Shift+Tab | indent, unindent: the `Indent`/`Unindent` actions exist; the binding is inferred | text mode |
| Ctrl+Backspace, Ctrl+Delete | delete word (the `DeleteStartOfWord`/`DeleteEndOfWord` actions; binding inferred) | text mode |
| Ctrl+Alt+Space | symbol menu (the on-screen symbols popup) | text mode |
| Ctrl+←/→, Ctrl+↑/↓ | word, paragraph | text mode |
| ←/→, PageUp/PageDown | previous/next page, scroll | not in text mode |
| Ctrl+F | search | document |
| Ctrl+Tab | open or close the drawer | document |
| Ctrl+, | settings | anywhere |
| Ctrl+N, Ctrl+Shift+N, Ctrl+O | new notebook, folder, quick sheet | library |
| Ctrl+Plus, Ctrl+Minus | zoom (keys by `TypeFolioLanguageModel.shortcutKey`) | document |
| Ctrl+Alt+F1…F12, Ctrl+Alt+←/→, Ctrl+Alt+Del | console switch / reboot specials in the QPA table | anywhere: **never bind** |

Free in every context we checked: **Ctrl+K, Ctrl+J, Ctrl+/, Ctrl+., Ctrl+;, Ctrl+Space,
Ctrl+Enter** (Ctrl+Enter may reach `SceneKeyHandler` as Enter or LineBreak; T0's handler dump
or a test decides). Alt+letter is free under the Windows flavour only.

### 3.2 Proposed codrawer chords

| Chord | Action | Where it runs |
| --- | --- | --- |
| **Ctrl+K** | command palette in the injected dock: ask about paragraph/page/selection, insert snippet, dictate, toggle agent ink, sink tablet/glasses, Primer proof/hint, read-page consent | extension (QML popup, like `dock.qml`) |
| **Ctrl+Enter** | send the current paragraph (or the selection) to the agent as a `term_prompt`, with this turn's ink | extension reads the paragraph (`text_read`), bridge sends `chord` + text |
| **Ctrl+/** | toggle agent ink (AI layer) for the session | router (`/ai`) |
| **Ctrl+J** | jump the glasses between transcript and page text view | app |
| **Ctrl+.** | stop the current reply (typing or insertion), as the ring tap does | bridge |
| **Ctrl+Space** | dictation push-to-talk (hold) or toggle (tap) | app via router |
| **Escape** | close codrawer's popup or palette if one is open; otherwise **pass to xochitl** (close document) | extension |

The glasses HUD keeps its own keys (`hud/keyboard.ts`: Enter commits, `/` completes, Ctrl+K the
editor's command line), but only in **codrawer focus** (below).

### 3.3 Intercepting without breaking typing

Three mechanisms, preferred first:

1. **An application event filter in the extension** (`QCoreApplication::instance()->
   installEventFilter(obj)` on the GUI thread). It sees every `QKeyEvent` after libepaper's
   translation and before any item or `Shortcut`. To beat a QML `Shortcut`, it accepts the
   `ShortcutOverride` event and swallows the matching `KeyPress`/`KeyRelease`. It is
   in-process, needs no grab, adds no latency, and uninstalls itself with the extension. It also
   gives an explicit **keyboard focus model**:
   - `page` (default): keys go to xochitl; the bridge still mirrors them to the glasses as `key`.
   - `codrawer`: the HUD line, palette, completion popup or editor panel own the keyboard. The
     filter swallows keys in xochitl; the bridge's `key` messages (from evdev, with its own
     keymap, so every ASCII character works) feed codrawer. Entered by Ctrl+K, Ctrl+J or `/` at
     the start of an empty paragraph (configurable); left by Escape or Enter.
   The extension tells the bridge which focus is active (`{"t":"chord",…,"state":…}`). The
   bridge stamps `key` messages with `"focus":"page|codrawer"`, so the app edits its line only
   in codrawer focus and the page and HUD never both take the same keystroke.
2. **EVIOCGRAB plus a pass-through uinput keyboard** (keyd/interception style) when the extension
   is absent: the bridge grabs the Pebble (`KEYBOARD_GRAB` exists) and re-emits every event it
   does not consume on its virtual keyboard. Typing still works, with under 1 ms added. The
   costs: the pass-through device inherits the keymap limits, a *hung* bridge leaves the
   keyboard dead to xochitl (a crash closes the fd, which releases the grab), and Escape still
   cannot be told apart by context. Use this for chords only, not for focus modes.
3. **Evdev only, no interception** (today): the bridge acts on Ctrl+K/J/., Ctrl+/ and Ctrl+Space,
   which xochitl ignores, and leaves Escape alone. Safe, but the HUD's Escape and its typed lines
   keep landing in the notebook.

### 3.4 Escape

Escape belongs to xochitl unless codrawer has something open. Phase 1 changes the HUD so it
stops relying on Escape outside codrawer focus. Ctrl+U clears the input line (Unix line-kill;
unbound in xochitl). Ctrl+K toggles the editor's command line instead of Escape closing it.
Ctrl+Backspace would not do: in text mode it is xochitl's delete-previous-word. With the event
filter, Escape closes codrawer's popup first, and only then reaches xochitl. ADR 005's "Escape
stops the current reply" becomes Ctrl+. or the ring tap.

---

## 4. `@` and `#` completions where the user types

- **Meaning** (aligned with the Primer's vocabulary; ADR 009/010 were not on `dev` when this was
  written). `@` names *who or what is addressed or attached*: an agent (`@claude`, `@primer`), a
  participant, a notebook or page (`@putnam-week3`). `#` names *a topic or a context bundle*: a
  Primer concept id (`#pigeonhole`, `#contrapositive`; about seventy in
  `src/codrawer_bridge/primer/concepts.py` on the Primer branch), a Putnam reference
  (`#putnam-2019-A1`, by year/number only, never bundled solutions), a wiki or context-graph page.
- **Trigger and token.** The extension watches `textCursorIndexChanged` and reads the paragraph
  (`ImSurroundingText`). When the text before the cursor matches `(^|\s)[@#][\w.-]{0,32}$`, it opens a
  popup. Typing continues normally into the page, so the popup filters as the token grows.
  `@` and `#` are typeable under all nine keyboard languages (some through AltGr;
  `epaper_keymap.py --json`). The extension sees characters, not keys, either way.
- **Popup.** Injected QML (the dock's pattern), placed at `textCursorPosition` mapped through
  `tileManager.sceneToView`, above the line if the cursor is low. Six rows, e-paper fast mode
  (`Epaper.ScreenModeItem.Animation`, as xochitl's keyboard area uses). While it is open, the
  event filter takes ↑/↓, Tab/Enter (accept) and Escape (close); everything else goes to the page.
- **Data without a round trip per key.** The router pushes `complete_index` per owner (Primer
  concepts, recent notebooks from pagewatch, participants, wiki titles); the bridge merges them into
  `/run/codrawer/complete.json`; the extension filters locally in QML JS (prefix, then fuzzy). A
  round trip is 16 ms median but 51 ms p95 over Wi-Fi (`keyboard-latency.md`), too slow per key on
  e-paper. Ranking: recency, then the learner's frontier for `#` (the Primer's `plan.queue`).
- **Accept.** `replaceText(insert, -tokenLength, tokenLength)` replaces the typed token in one
  call; it can be styled (bold `@claude`). What it means downstream: `Ctrl+Enter` on a paragraph
  containing `@primer #pigeonhole` sends a `term_prompt` (or `primer_request`) with
  `context:[{"kind":"concept","id":"pigeonhole"}]`. The router resolves mentions to files the
  agent Reads (ADR 002 pattern).

## 5. Snippets and macros

- **Triggers.** `;;name` followed by space or Tab, detected by the extension in the paragraph
  text (not in the bridge's key stream, which cannot see the cursor). `;;` plus a name is never
  typed by accident in prose or LaTeX.
- **Expansion.** `replaceText` removes the trigger, then the snippet's blocks go in through
  `text_insert` with styles. `$0` places the cursor. `textplan.py` has a prototype set: `;;thm`,
  `;;lem`, `;;pf` (*Proof.* … ∎), `;;contra`, `;;ind` (base case / inductive step bullets),
  `;;cases`, `;;claim`, `;;putnam` (Problem / Answer / Proof skeleton), mapped to xochitl's
  paragraph styles. `uv run python scripts/dev/textplan.py ";;ind"` prints the operation.
- **LaTeX templates** (`;;align`, `;;frac`, `;;sum`) insert LaTeX *source* as text. xochitl has
  no maths rendering and no maths font, and `\ { } ^` are not typeable on the key path, so
  route A is the only way this source arrives intact. Rendering belongs to the editor panel and
  the LaTeX research.
- **Macros.** A snippet may carry a follow-up action (`{"after":"term_prompt","text":"check this
  proof"}`), so `;;check` inserts a divider and asks the agent about the paragraph above.
- **Where the set lives.** A user-editable `snippets.md` on the desktop, pushed as `snippets` (§
  1.5) and cached in `/run/codrawer/snippets.json`; the Primer can contribute entries the way it
  contributes dock entries.

## 6. A codrawer editor panel (LaTeX and code)

- **Why.** xochitl's text model has no monospace or code style, no maths and seven untypeable
  ASCII characters on the key path. LaTeX and code need all of those.
- **What.** An injected QML panel, a Qt Quick `TextEdit` in Noto Sans Mono (on the device),
  docked at the page's bottom or side, e-paper fast mode while typing. It takes **no** keys from
  xochitl: in codrawer focus the event filter swallows xochitl's key events, and the bridge feeds
  the panel from evdev over the socket (`{"op":"panel_key","key":"BracketLeft","char":"["}`),
  translated with the bridge's own keymap, so every ASCII character works. Ctrl+Enter sends the
  panel's content to the agent. Ctrl+Shift+Enter renders it.
- **Output.** (a) Insert as text (route A) when it is prose. (b) Render LaTeX to an image on the
  desktop and insert it with `SceneController.insertImageAsSceneItem(QImage)` or
  `insertImageFileAsSceneItem(QUrl, QPointF)`; both are in the meta-object, and the result is
  native, movable and saved. (c) Agent ink on the AI layer (ADR 003).
- **Coordination.** `research/latex-on-tablet` (a local branch at `a690ab4`, not pushed, nothing
  committed when this was written) owns the rendering choice (KaTeX/MathJax on the desktop vs ink
  vs image). This panel is its input surface, and `insertImage*` is a candidate output.
- **Shared state.** The panel's buffer is the same `doc` the glasses `/edit` editor shares (Yjs
  `doc_update`), so the tablet panel, the glasses editor and the agent all see one document.

## 7. Reading text as context

- **Scopes.** `cursor`/`paragraph`/`selection` through `text_read` (live, from the input-method
  query); `page` from the saved `.rm`'s RootText (lags by xochitl's save cadence, 6–10 s,
  `xochitl-pen-data.md`). That needs a RootText decoder next to the stroke parser (rmscene's
  format: CRDT text items, paragraph styles, bold/italic runs), and `page` messages then gain
  `text`. The `dumpScene` slot is a debug dump, not an API.
- **Consent.** Off by default, per learner and session, the Primer coach's model: `/read on` or a
  palette entry. The dock shows a "reading" badge while it is on. Only the visible page is ever
  read, never other notebooks. Ctrl+Enter is consent for that one paragraph.
- **Delivery.** The router writes `.codrawer/page-text.md` (with paragraph styles as markdown) for
  the agent to Read, as `doc.md` already works, and appends a trailer to the `term_prompt`.

## 8. Dictation

- **The microphone exists.** Even Hub SDK 0.0.16: `bridge.audioControl(true,
  AudioInputSource.Glasses | AudioInputSource.Phone)` after the startup page is created. PCM frames
  arrive in `onEvenHubEvent` as `audioEvent.audioPcm` (`Uint8Array`), with `speakerRole`
  (self/other) from the app's own algorithm. Sample rate and format are not documented; measure
  them first (frame size against time).
- **Speech to text.** Stream the frames over the existing WebSocket to the desktop router and run
  STT there (a local Whisper-class model, or a cloud API with the user's key), then send
  `text_insert` with `source:"dictation"` to the tablet. Partial results go to the glasses as
  they arrive. The final text goes to the page in one insert at the cursor, one undo step.
  Spoken punctuation and "new paragraph" map to blocks.
- **Web Speech API in the WebView: do not rely on it.** Android's WebView does not implement
  `SpeechRecognition`. Support in an iOS `WKWebView` is limited and needs microphone permission
  that the Even app's host would have to grant. A feature probe in the app costs nothing
  (`'webkitSpeechRecognition' in window`), but the SDK microphone is the supported path.
- **Costs.** Glasses-mic audio crosses BLE to the phone and competes with display updates (ADR
  006 latency budget). The phone microphone avoids that. Measure both before choosing a
  default.

## 9. Multilingual and IME, briefly

- Route A takes any Unicode. The device has Noto CJK (JP/KR/SC), Arabic, Hebrew, Devanagari, Thai
  and Lao, so dictated or agent text in those scripts should render (verify RTL layout in the root
  document).
- `SceneController` already has an IME surface: `setPreeditText`, `setComposeRange`,
  `replaceComposeText(text, pos, Continue|Commit)`, `composeWordAtCursorEnabled`. A phone- or
  desktop-side IME (pinyin, kana) can show composition inline and commit through route A.
- The Pebble's physical layout and xochitl's keyboard language should match. The bridge's
  glasses keymap should come from the same table (§ 2.4). The nine Type Folio tables are the
  only layouts xochitl knows.
- Maths symbols (∀ ∃ ≤ ∈ ∑) go in through route A or snippets. Noto Sans covers many of them but
  not all, and there is no maths font: check the rendering of a Putnam-typical set before
  promising it.

---

## 10. Features at a glance

| # | Feature | Value | Effort | Risk | Depends on | Maps onto |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Direct insertion (route A, verify, styles, undo) | **very high**: replies arrive whole, every character, styled, undoable | 3–4 d (probes T0–T6 1 d, extension 1.5 d, bridge 1 d) | medium: names are stable across point releases; `replaceText` behaviour unprobed | XOVI + codrawer-layer running; compat.conf | `main.cpp` "Text into the focused text box" (WIP), `agent_ink.go`/`agent_ink.rs` (WIP), router: `term` with sink tablet → `text_insert` |
| 2 | Fallback fixes (filter, gate, prime, settle, locale keymap) | high (the path whenever XOVI is off) | 1.5 d | low | pen/touch readers (exist) | `typer.rs`, `typer.go`, `keymap.rs`, `keyboard.go`, `epaper_keymap.py` |
| 3a | Escape conflict and focus model (event filter) | high (stops closing notebooks; stops double typing) | 1.5 d | medium: event filter vs QML `Shortcut` ordering to verify | 1 | extension filter; `key.focus`; `hud/keyboard.ts` |
| 3b | Chords (Ctrl+Enter, Ctrl+/, Ctrl+., Ctrl+J) | medium-high | 1 d | low | 3a (or evdev-only) | `chord` message; router; app |
| 3c | Ctrl+K palette | medium | 1.5 d | low (dock pattern exists) | 3a, dock injection | `qml/palette.qml` beside `dock.qml` |
| 4 | `@`/`#` completions | high for the Primer (concepts, problems) | 3 d | medium: popup placement under zoom/scroll; e-paper refresh | 1, 3a, `complete_index` | extension QML + `text_watch`; router index from `primer/concepts.py`, pagewatch |
| 5 | Snippets and macros | high for Putnam write-ups | 1.5 d | low | 1 (`text_watch`) | `textplan.py` → bridge/router; `snippets` message |
| 6 | Editor panel (LaTeX/code) | high for LaTeX, medium otherwise | 5–8 d | medium-high: focus handling, e-paper typing latency | 3a, LaTeX research | extension QML panel, `panel_key`, `doc_update`, `insertImageAsSceneItem` |
| 7 | Reading text as context | high for the Primer and agents | paragraph 0.5 d; page 2 d (RootText decoder) | low (read-only) | 1 (`text_read`); rmlines | `text_read`; `rust/src/rmlines`, `native/rmlines`; `page.text` |
| 8 | Dictation | medium-high (hands on the pen) | 4–6 d | medium: PCM format, BLE budget, STT cost | 1, router STT | app `audioControl`; router; `text_insert` |
| 9 | Multilingual/IME | low now | — | — | 1 | `setPreeditText` / `replaceComposeText` |

## 11. Phased plan

**Phase 1: text arrives whole (about 1.5 weeks).**
1. Probes T0–T7 on a scratch page (needs the user and a XOVI session; the extension already
   has `dump` and the signal spy).
2. Extension: route A with `ensureFocus`, blocks/styles, undo grouping, verify-by-read-back.
   Route B (the WIP) stays second. `text_read` paragraph/cursor.
3. Bridge: `text_insert` client with capability check (WIP), per-operation fallback, and
   `text_result` up to the router. The uinput device is created lazily.
4. Fallback: character filter, pen/touch-clear gate, prime, Enter settle, locale keymap from
   `epaper_keymap.py`.
5. Escape: the HUD stops relying on it outside codrawer focus; ADR 005 amended (stop = Ctrl+. or
   ring).
6. Router/app: `text_insert`/`text_result` relayed; the glasses show what the fallback dropped.
   Protocol documented.

**Phase 2: the keyboard drives codrawer (about 2 weeks).** Event filter and focus model; chords
(Ctrl+Enter, Ctrl+/, Ctrl+., Ctrl+J, Ctrl+Space); the Ctrl+K palette; `text_watch`; `@`/`#`
completions over `complete_index` (Primer concepts, recent notebooks, participants); snippets
with the Putnam set and the `snippets` message.

**Phase 3: beyond xochitl's text model (3–4 weeks).** The editor panel fed from evdev, with
LaTeX render-to-image through `insertImageAsSceneItem` (with the LaTeX research); dictation
(SDK microphone → router STT → `text_insert`); page-text context through a RootText decoder,
under the consent model.

## Appendix: spikes in this branch

- `scripts/dev/epaper_keymap.py`: reads xochitl's keyboard tables out of a local copy of
  `libepaper.so`, and prints the untypeable ASCII, dead keys and console specials per language
  (`--json` for a typer table). Requires `uv run --with pyelftools`.
- `scripts/dev/textplan.py`: the markdown/snippet → `text_insert` blocks planner (styles, bold
  and italic in UTF-16 offsets, `$0` cursor) and the fallback character filter; `--test` runs its
  checks.
