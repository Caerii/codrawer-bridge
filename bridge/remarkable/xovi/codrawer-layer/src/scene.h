// scene.h: finding xochitl's live objects: the item tree, the open page, its layers.
//
// # The problem
//
// The extension hooks nothing, so it must find the objects it talks to by walking what Qt shows
// it: the item trees of the application's QQuickWindows, and the QObjects parented under them.
// The objects that matter (docs/investigations/native-multiplayer-layer.md §2):
//
//   DocumentView        a QML FocusScope, the item with `controller`, `strokeHandler`, `pageId`,
//                       `tileManager` and `viewport` properties. One per open document view.
//   SceneController     the page's scene (layers, lines, text): DocumentView.controller
//   pen handler         ScenePenInputHandler / PenInputLineHandler: DocumentView.strokeHandler
//   SceneTileManager    renders lines into the page's tiles: DocumentView.tileManager
//   DeviceSceneViewport the page's repaint target: DocumentView.viewport
//
// xochitl keeps neighbouring pages' SceneViews alive, so a SceneController found by scanning may
// belong to a page that is not on screen. The controller is therefore always taken from a
// *visible* DocumentView, and a command that changes the page names the page it expects and is
// refused unless both the view and its controller are on it (`findOpenPage`).
//
// Layers are read through `SceneController.layerName(int)`: on 3.29.0.149 `layerStates` reads
// as an invalid QVariant from C++ (it is not a registered sequential type there).
//
// The item selector language (`matchItems`) is shared by injection, automation and the `tree`
// probe:
//
//   class:<substring>    the item's class name contains it (e.g. class:Toolbar)
//   name:<objectName>    the item's objectName equals it
//   text:<text>          the item's `text` property equals it
//   prop:<name>=<value>  any readable property, compared as a string
//
// # Threading
//
// GUI thread only. A full walk (`allItems`) costs tens of milliseconds of GUI time on the Paper
// Pro, so periodic code walks only while it has nothing cached (toolfollow.cpp).
#pragma once

#include <QtCore/QList>
#include <QtCore/QObject>
#include <QtCore/QString>
#include <QtQuick/QQuickItem>

namespace cdl {

// Every item in every QQuickWindow's tree, depth-first from each content item (depth ≤ 200).
QList<QQuickItem *> allItems();

// A DocumentView and the objects it carries. Pointers may be null where the view lacks one.
struct OpenPage {
    QQuickItem *view = nullptr;      // DocumentView
    QObject *controller = nullptr;   // SceneController of the page the view shows
    QObject *pen = nullptr;          // ScenePenInputHandler ("strokeHandler")
    QObject *tiles = nullptr;        // SceneTileManager
    QObject *viewport = nullptr;     // DeviceSceneViewport
    QString pageId;                  // the view's page uuid
};

// Every DocumentView in the item trees, visible or not, in tree order.
QList<OpenPage> findDocumentViews();

// The DocumentView showing `expectedPage`, if it is visible and its controller's `pageId`
// agrees; otherwise false, with the reason logged (`refuse: …`). The guard every page-changing
// command and every ink commit goes through.
bool findOpenPage(const QString &expectedPage, OpenPage &page);

// Every QObject of class `cls` (or a subclass) reachable from the windows' content items and
// the application object, each once. QML puts non-visual objects (a DocumentLockManager, a
// QmlDocumentWrapper) under the item that declares them, so `findChildren` reaches them.
QList<QObject *> findObjectsOfClass(const char *cls);

// One layer of a page: its index (0 = the user's base layer), its name, and a description for
// the log.
struct LayerInfo {
    int index;
    QString name;
    QString raw;
};

// The page's layers in index order, read through `layerName(int)` and `isLayerVisible(int)`
// (or, on a build without them, the `layerStates` gadgets).
QList<LayerInfo> layers(QObject *controller);

// Logs the layer count, the current layer and every layer (`layers <when>: …`).
void logLayers(QObject *controller, const char *when);

// The index of the first layer named exactly `name`, or −1. Layers are found by name because
// indices move when layers are added or removed.
int findLayer(QObject *controller, const QString &name);

// `layerName(i)` of the controller, or an empty string.
QString layerNameAt(QObject *controller, int i);

// The items matching a selector (see above; without the injection's `^`), in tree order.
QList<QQuickItem *> matchItems(const QString &spec);

// Logs the item tree, read-only, for finding where to inject. Without `match`: every window's
// tree to `depth`. With `match`: how many items match, and for each of the first 8 its ancestry
// and subtree to `depth`. Each item: class, objectName, geometry (local and scene), visibility,
// and `text`/`iconSource`/`source`/`icon`/`title`/`checked`/`enabled` where it has them.
void logTree(const QString &match, int depth);

}  // namespace cdl
