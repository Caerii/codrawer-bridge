// qtmeta.h: reaching xochitl's objects through Qt's meta-objects, without moc and without symbols.
//
// # The problem
//
// xochitl is a stripped PIE: none of its C++ functions can be called by name. Its QML, though,
// calls into C++ through Qt's meta-object system (`controller.addLayer()` is a meta-call), and
// every class QML can see carries its method, property and signal tables at run time. Calling
// through those tables needs no xochitl symbol and is exactly the route QML takes
// (docs/investigations/native-multiplayer-layer.md §1-2). The extension does everything this way.
//
// The extension is also built without moc (build.sh compiles plain C++), so it cannot declare
// slots or signals of its own. `Relay` connects a signal to a C++ function anyway, the way
// Qt's own QSignalSpy does: by meta-method index, with `qt_metacall` dispatching.
//
// # What is here
//
//   dumpMetaObject, dumpValues   the read-only introspection the `dump` probe logs
//   invoke                       call a meta-method by name with converted arguments
//   firstProp                    the first of several property names an object has, as JSON
//   Relay                        signals into std::functions
//   waitFor                      poll a condition on a GUI-thread timer, never blocking
//
// # Threading
//
// Everything here runs on xochitl's GUI thread: calling Qt Quick objects off it crashes xochitl
// (inkling and smart_remarkable both learned this), and a GUI-thread job must stay short, well
// inside xochitl's 60 s systemd watchdog. `waitFor` exists so that waiting for an effect never
// blocks that thread.
#pragma once

#include <QtCore/QJsonValue>
#include <QtCore/QMetaMethod>
#include <QtCore/QObject>
#include <QtCore/QVariant>

#include <functional>
#include <initializer_list>
#include <vector>

namespace cdl {

// Logs every class in `mo`'s chain down to (not including) QObject/QQuickItem/QQuickPaintedItem:
// constructors, methods with their return types and signatures, properties with type and access
// (r/w), enums with their keys. `label` heads the dump. Read-only.
void dumpMetaObject(const QMetaObject *mo, const char *label);

// Logs the named properties of `o` on one line (`<none>` for those it lacks). The names are a
// whitelist on purpose: reading arbitrary getters can block on xochitl's document worker.
void dumpValues(QObject *o, const char *label, std::initializer_list<const char *> names);

// Whether `o`'s meta-object declares every one of `names` as a property.
bool hasProps(const QObject *o, std::initializer_list<const char *> names);

// Calls `o`'s meta-method `name` with `args`, converted to the method's declared parameter types,
// as a direct QMetaObject::metacall (on the calling thread, which must be the GUI thread). Among
// overloads with the right arity, the last declared whose parameters all convert is called
// (sceneToView(QPointF) vs (QRectF)). The return value, if any, goes to `ret`. False, and a log
// line, if no overload fits. At most 10 arguments.
//
// Functions declared in QML JavaScript without type annotations appear in the meta-object with
// QVariant parameters and a QVariant return (`openPage(QVariant,QVariant)`, `onOpened(QVariant)`).
// For those the QVariant itself is passed and returned, unconverted: a QVariantMap argument
// arrives in JavaScript as an object.
bool invoke(QObject *o, const char *name, QVariantList args, QVariant *ret = nullptr);

// The first of `names` that `o` has as a valid readable property, as a JSON value: bool as
// bool, numbers (not strings) as double, anything convertible as a string; null if none.
QJsonValue firstProp(QObject *o, std::initializer_list<const char *> names);

// Signals into functions. Each connected signal is one extra meta-method index of this object
// (after QObject's own); `qt_metacall` calls the function registered for that index with the
// signal's raw argument array (a[0] the return slot, a[1..] the arguments). Connections are
// direct, so a function runs in the emitting thread: everything the extension connects is
// emitted on the GUI thread (the pen handler, the scene controller, injected QML). Deleting the
// Relay disconnects everything it connected.
class Relay : public QObject {
public:
    using Fn = std::function<void(void **)>;

    // Connects `sender`'s `signal` to `fn`; false if `signal` is not a signal of a live sender or
    // Qt refuses the connection.
    bool on(QObject *sender, const QMetaMethod &signal, Fn fn);

    // The notify signal of `sender`'s property `name`, or an invalid QMetaMethod.
    static QMetaMethod notifyOf(QObject *sender, const char *name);

    // A signal of `sender` by its name (the first overload declared), or an invalid QMetaMethod.
    static QMetaMethod signalNamed(QObject *sender, const char *name);

    int qt_metacall(QMetaObject::Call call, int id, void **a) override;

private:
    std::vector<Fn> fns_;  // index = slot - QObject's method count; never shrinks (indices stay valid)
};

// Calls `then(true)` as soon as `cond()` holds (at once if it already does), or `then(false)`
// after `timeoutMs` ms. Polls every 20 ms on a GUI-thread timer; nothing blocks. Call on the GUI
// thread; `cond` and `then` run there.
void waitFor(std::function<bool()> cond, int timeoutMs, std::function<void(bool)> then);

}  // namespace cdl
