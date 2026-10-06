// A stand-in for xochitl's xofm.libs.epaper ScreenModeItem (a C++ scene-graph item telling the
// e-paper driver how to refresh its region), with the members dock.qml uses.
import QtQuick

Item {
    enum Mode { UI, Pen, Mono, Animation, Content, Sleep, Overlay }
    property int mode: ScreenModeItem.UI
}
