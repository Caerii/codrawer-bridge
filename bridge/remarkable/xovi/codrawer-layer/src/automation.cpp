// automation.cpp: see automation.h.
#include "automation.h"

#include "auto_rules.h"
#include "autoinput.h"
#include "autostate.h"
#include "inksock.h"
#include "log.h"
#include "paths.h"
#include "qtmeta.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>

#include <algorithm>
#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <memory>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace cdl {

namespace {

std::function<void()> &clientsChangedHook() {
    static std::function<void()> h;
    return h;
}

void clientsChanged() {
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] {
        if (clientsChangedHook()) clientsChangedHook()();
    }, Qt::QueuedConnection);
}

// Handles one request on the GUI thread; `reply` gets the JSON reply (possibly later: wait_for,
// gestures, grab, text route A).
void autoRequest(const QJsonObject &req, std::function<void(QJsonObject)> reply) {
    const QString id = req.value(QStringLiteral("id")).toVariant().toString();
    const QString cmd = req.value(QStringLiteral("cmd")).toString();
    auto answer = [id, reply](QJsonObject o) {
        o.insert(QStringLiteral("id"), id);
        reply(o);
    };
    auto fail = [answer](const QString &why) { answer(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), why}}); };
    logLine(QStringLiteral("auto: %1 %2").arg(cmd, QString::fromUtf8(QJsonDocument(req).toJson(QJsonDocument::Compact)).left(200)));
    if (cmd == QLatin1String("state")) {
        answer(QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("state"), autoState()}});
        return;
    }
    if (lockScreenUp()) return fail(QStringLiteral("locked"));
    if (cmd == QLatin1String("resume")) {
        autoPaused() = false;
        answer(QJsonObject{{QStringLiteral("ok"), true}});
        return;
    }
    if (autoPaused()) return fail(QStringLiteral("paused (the user touched the page; send resume)"));
    if (cmd == QLatin1String("find")) {
        const QString sel = req.value(QStringLiteral("selector")).toString();
        if (sel.indexOf(QLatin1Char(':')) <= 0) return fail(QStringLiteral("selector must be class:|name:|text:|prop:"));
        QJsonObject o = autoFind(sel);
        o.insert(QStringLiteral("ok"), true);
        answer(o);
        return;
    }
    if (cmd == QLatin1String("wait_for")) {
        const autorules::Cond c = autorules::parseCond(req.value(QStringLiteral("cond")).toString().toStdString());
        if (!c.ok) return fail(QStringLiteral("cond must be '<path> <op> <value>'"));
        const int timeout = std::clamp(req.value(QStringLiteral("timeout_ms")).toInt(3000), 0, 60000);
        const qint64 t0 = nowMs();
        waitFor([c] { return autorules::evalCond(c, statePath(autoState(), c.path)); }, timeout,
                [answer, c, t0](bool ok) {
                    answer(QJsonObject{{QStringLiteral("ok"), ok},
                                       {QStringLiteral("waited_ms"), double(nowMs() - t0)},
                                       {QStringLiteral("value"), QString::fromStdString(statePath(autoState(), c.path))}});
                });
        return;
    }
    if (autoInputRequest(cmd, req, answer)) return;
    fail(QStringLiteral("unknown command (state, find, wait_for, resume, grab, tap, long_press, swipe, tap_item, tool, open, goto, text_insert, text_read)"));
}

// Serves one client (either listener) until it closes or sends a line over 64 KiB.
void serveAuto(const std::shared_ptr<SocketClient> &cl) {
    ++autoClients();
    clientsChanged();
    QByteArray buf;
    char chunk[8192];
    for (;;) {
        const ssize_t n = read(cl->fd, chunk, sizeof chunk);
        if (n <= 0) break;
        buf.append(chunk, int(n));
        if (buf.size() > (1 << 16)) break;
        qsizetype nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const QByteArray line = buf.left(nl).trimmed();
            buf.remove(0, nl + 1);
            if (line.isEmpty()) continue;
            const QJsonDocument d = QJsonDocument::fromJson(line);
            if (!d.isObject()) {
                cl->reply(QStringLiteral("{\"ok\":false,\"error\":\"bad json\"}"));
                continue;
            }
            const QJsonObject req = d.object();
            QMetaObject::invokeMethod(QCoreApplication::instance(), [cl, req] {
                autoRequest(req, [cl](const QJsonObject &o) { cl->reply(QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact))); });
            }, Qt::QueuedConnection);
        }
    }
    cl->open = false;
    --autoClients();
    clientsChanged();
}

}  // namespace

void setAutoClientsChangedHook(std::function<void()> fn) { clientsChangedHook() = std::move(fn); }

void autoTcpServer() {
    for (;;) {
        while (access(kAutoOptIn, F_OK) != 0) sleep(2);
        const int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
        int one = 1;
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(kAutoPort);
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (s < 0 || bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof addr) != 0 || listen(s, 1) != 0) {
            logLine(QStringLiteral("auto: cannot listen on 127.0.0.1:%1 (errno %2)").arg(kAutoPort).arg(errno));
            if (s >= 0) close(s);
            sleep(10);
            continue;
        }
        logLine(QStringLiteral("auto: listening on 127.0.0.1:%1").arg(kAutoPort));
        while (access(kAutoOptIn, F_OK) == 0) {
            const int fd = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
            if (fd < 0) continue;
            if (access(kAutoOptIn, F_OK) != 0) {
                close(fd);
                break;
            }
            logLine(QStringLiteral("auto: tcp client connected"));
            serveAuto(std::make_shared<SocketClient>(fd));
            logLine(QStringLiteral("auto: tcp client gone"));
        }
        close(s);
    }
}

void autoServer() {
    for (;;) {
        while (access(kAutoOptIn, F_OK) != 0) sleep(2);
        unlink(kAutoSock);
        const int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        std::strncpy(addr.sun_path, kAutoSock, sizeof addr.sun_path - 1);
        if (s < 0 || bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof addr) != 0 || listen(s, 1) != 0) {
            logLine(QStringLiteral("auto: cannot listen on %1 (errno %2)").arg(QString::fromLatin1(kAutoSock)).arg(errno));
            if (s >= 0) close(s);
            sleep(10);
            continue;
        }
        chmod(kAutoSock, 0600);
        logLine(QStringLiteral("auto: listening on %1 (opt-in %2 present)").arg(QString::fromLatin1(kAutoSock), QString::fromLatin1(kAutoOptIn)));
        while (access(kAutoOptIn, F_OK) == 0) {
            const int fd = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
            if (fd < 0) continue;
            if (access(kAutoOptIn, F_OK) != 0) {
                close(fd);
                break;
            }
            logLine(QStringLiteral("auto: client connected"));
            serveAuto(std::make_shared<SocketClient>(fd));
            logLine(QStringLiteral("auto: client gone"));
        }
        close(s);
        unlink(kAutoSock);
        logLine(QStringLiteral("auto: opt-in removed; socket closed"));
    }
}

}  // namespace cdl
