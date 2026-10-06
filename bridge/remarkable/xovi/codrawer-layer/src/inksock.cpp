// inksock.cpp: see inksock.h.
#include "inksock.h"

#include "ink.h"
#include "ink_protocol.h"
#include "log.h"
#include "paths.h"
#include "text.h"
#include "toolfollow.h"

#include <QtCore/QCoreApplication>
#include <QtCore/QJsonArray>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QJsonValue>

#include <cerrno>
#include <cmath>
#include <cstring>
#include <memory>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace cdl {

SocketClient::~SocketClient() { close(fd); }

void SocketClient::reply(const QString &s) {
    std::lock_guard<std::mutex> lock(sending);
    if (!open) return;
    const QByteArray b = s.toUtf8() + '\n';
    if (send(fd, b.constData(), size_t(b.size()), MSG_NOSIGNAL | MSG_DONTWAIT) < 0) open = false;
}

namespace {

// ---------------------------------------------------------------------------------------------
// Shared state: the connected bridge and its status line.

std::mutex &inkClientMutex() {
    static std::mutex m;
    return m;
}
std::weak_ptr<SocketClient> &currentInkClient() {
    static std::weak_ptr<SocketClient> c;
    return c;
}

std::mutex &bridgeStatusMutex() {
    static std::mutex m;
    return m;
}
QString &bridgeStatusLine() {
    static QString s;
    return s;
}
std::function<void()> &bridgeStatusHook() {
    static std::function<void()> h;
    return h;
}

// From the socket's thread: keep the line, and let the GUI thread show it.
void setBridgeStatus(const QString &line) {
    {
        std::lock_guard<std::mutex> lock(bridgeStatusMutex());
        bridgeStatusLine() = line;
    }
    QMetaObject::invokeMethod(QCoreApplication::instance(), [] {
        if (bridgeStatusHook()) bridgeStatusHook()();
    }, Qt::QueuedConnection);
}

// ---------------------------------------------------------------------------------------------
// Parsing a stroke message.

int toolFromJson(const QJsonValue &v) {
    if (v.isDouble()) return inkproto::toolFromNumber(v.toInt(-1));
    return inkproto::toolFromName(v.toString(QStringLiteral("fineliner")).toStdString());
}

// Parses one socket line into a job; on failure returns false with `why` (`id` is set as far as
// it was read).
bool parseInk(const QByteArray &line, InkJob &job, QString &id, QString &why) {
    QJsonParseError pe;
    const QJsonDocument doc = QJsonDocument::fromJson(line, &pe);
    if (pe.error != QJsonParseError::NoError || !doc.isObject()) {
        why = QStringLiteral("bad json");
        return false;
    }
    const QJsonObject o = doc.object();
    id = o.value(QStringLiteral("id")).toVariant().toString().left(64);
    id.replace(QLatin1Char(' '), QLatin1Char('_'));
    if (id.isEmpty()) id = QStringLiteral("-");
    job.page = o.value(QStringLiteral("page")).toString();
    if (job.page.size() != 36) {
        why = QStringLiteral("page must be a uuid");
        return false;
    }
    const QString layer = o.value(QStringLiteral("layer")).toString(QStringLiteral("agent"));
    if (layer == QLatin1String("agent")) job.layer = kAgentLayer();
    else if (layer == QLatin1String("test")) job.layer = kTestLayer();
    else {
        why = QStringLiteral("layer must be agent or test");
        return false;
    }
    const QJsonArray strokes = o.value(QStringLiteral("strokes")).toArray();
    if (!inkproto::strokeCountOk(strokes.size())) {
        why = QStringLiteral("1..%1 strokes per message").arg(inkproto::kMaxBatch);
        return false;
    }
    for (const QJsonValue &sv : strokes) {
        const QJsonObject so = sv.toObject();
        InkStroke st;
        st.tool = toolFromJson(so.value(QStringLiteral("tool")));
        if (st.tool < 0) {
            why = QStringLiteral("tool not allowed");
            return false;
        }
        const QJsonValue av = so.value(QStringLiteral("argb"));
        bool okArgb = true;
        st.argb = av.isString() ? av.toString().toUInt(&okArgb, 16) : quint32(av.toDouble(double(0xff000000u)));
        if (!okArgb) {
            why = QStringLiteral("bad argb");
            return false;
        }
        st.thickness = so.value(QStringLiteral("thickness")).toDouble(2.0);
        if (!inkproto::thicknessOk(st.thickness)) {
            why = QStringLiteral("thickness out of range");
            return false;
        }
        const QJsonArray pts = so.value(QStringLiteral("pts")).toArray();
        if (!inkproto::pointCountOk(pts.size())) {
            why = QStringLiteral("1..4000 points per stroke");
            return false;
        }
        for (int i = 0; i < pts.size(); ++i) {
            const QJsonArray a = pts[i].toArray();
            if (a.size() < 2) {
                why = QStringLiteral("point needs x,y");
                return false;
            }
            const double x = a[0].toDouble(NAN), y = a[1].toDouble(NAN);
            const double pr = a.size() > 2 ? a[2].toDouble(0.5) : 0.5;
            const double wpx = a.size() > 3 ? a[3].toDouble(st.thickness * 2) : st.thickness * 2;
            if (!inkproto::pointOk(x, y, wpx)) {
                why = QStringLiteral("point %1 out of range").arg(i);
                return false;
            }
            st.pts << inkproto::toPoint(x, y, pr, wpx);
        }
        inkproto::fillDirections(st.pts);
        job.strokes << st;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Serving one client.

// A text op line, answered on the GUI thread: text_read, or text_insert by route A then B.
void handleTextOp(const std::shared_ptr<SocketClient> &cl, const QByteArray &line) {
    const QJsonObject o = QJsonDocument::fromJson(line).object();
    const QString op = o.value(QStringLiteral("op")).toString();
    QString tid = o.value(QStringLiteral("id")).toString().left(64);
    tid.replace(QLatin1Char(' '), QLatin1Char('_'));
    if (tid.isEmpty()) tid = QStringLiteral("-");
    const QString text = o.value(QStringLiteral("text")).toString();
    if ((op != QLatin1String("text_insert") && op != QLatin1String("text_read")) ||
        (op == QLatin1String("text_insert") && (text.isEmpty() || text.size() > kMaxTextInsert))) {
        cl->reply(QStringLiteral("err %1 bad op or text").arg(tid));
        return;
    }
    QMetaObject::invokeMethod(QCoreApplication::instance(), [cl, op, tid, text] {
        auto send = [cl, op, tid](const QString &r) {
            if (r.startsWith(QLatin1String("err "))) logLine(QStringLiteral("text: refused %1: %2").arg(op, r.mid(4)));
            const int sp = r.indexOf(QLatin1Char(' '));
            cl->reply(r.left(sp) + QLatin1Char(' ') + tid + r.mid(sp));
        };
        if (op == QLatin1String("text_read")) {
            send(textRead());
        } else if (userTouching()) {
            send(QStringLiteral("err pen or finger on the page"));  // the write-back guard
        } else if (!textInsertRouteA(text, send)) {
            send(textInsert(text));  // route B: the focused item, as an input method
        }
    }, Qt::QueuedConnection);
}

void serveInk(const std::shared_ptr<SocketClient> &cl) {
    {
        std::lock_guard<std::mutex> lock(inkClientMutex());
        currentInkClient() = cl;
    }
    cl->reply(QStringLiteral("hello codrawer-layer ink text_insert text_read"));
    QByteArray buf;
    char chunk[16384];
    for (;;) {
        const ssize_t n = read(cl->fd, chunk, sizeof chunk);
        if (n <= 0) break;
        buf.append(chunk, int(n));
        qsizetype nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const QByteArray line = buf.left(nl).trimmed();
            buf.remove(0, nl + 1);
            if (line.isEmpty()) continue;
            if (line.startsWith("status ")) {
                setBridgeStatus(QString::fromUtf8(line.mid(7)).left(200));
                continue;
            }
            if (line.contains("\"op\"")) {
                handleTextOp(cl, line);
                continue;
            }
            InkJob job;
            QString id, why;
            if (!parseInk(line, job, id, why)) {
                logLine(QStringLiteral("ink: refused %1: %2").arg(id, why));
                cl->reply(QStringLiteral("err %1 %2").arg(id.isEmpty() ? QStringLiteral("-") : id, why));
                continue;
            }
            job.done = [cl, id](const QString &r) {
                const int sp = r.indexOf(QLatin1Char(' '));
                cl->reply(sp < 0 ? r + QLatin1Char(' ') + id : r.left(sp) + QLatin1Char(' ') + id + r.mid(sp));
            };
            QMetaObject::invokeMethod(QCoreApplication::instance(), [job]() mutable { enqueueInk(std::move(job)); },
                                      Qt::QueuedConnection);
        }
        if (buf.size() > inkproto::kMaxLineBytes) {
            cl->reply(QStringLiteral("err - line over 1 MiB; closing"));
            break;
        }
    }
    cl->open = false;
    std::lock_guard<std::mutex> lock(inkClientMutex());
    if (currentInkClient().lock() == cl) currentInkClient().reset();
}

}  // namespace

void inkServer() {
    mkdir(kRunDir, 0755);
    unlink(kInkSock);
    const int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, kInkSock, sizeof addr.sun_path - 1);
    if (s < 0 || bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof addr) != 0 || listen(s, 2) != 0) {
        logLine(QStringLiteral("ink: cannot listen on %1 (errno %2)").arg(QString::fromLatin1(kInkSock)).arg(errno));
        if (s >= 0) close(s);
        return;
    }
    chmod(kInkSock, 0600);
    logLine(QStringLiteral("ink: listening on %1").arg(QString::fromLatin1(kInkSock)));
    for (;;) {
        const int fd = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
        if (fd < 0) {
            if (errno != EINTR) sleep(1);
            continue;
        }
        logLine(QStringLiteral("ink: client connected"));
        serveInk(std::make_shared<SocketClient>(fd));
        logLine(QStringLiteral("ink: client gone"));
    }
}

bool sendToBridge(const QByteArray &line) {
    std::shared_ptr<SocketClient> cl;
    {
        std::lock_guard<std::mutex> lock(inkClientMutex());
        cl = currentInkClient().lock();
    }
    if (!cl || !cl->open) return false;
    cl->reply(QString::fromUtf8(line));
    return cl->open;
}

bool bridgeConnected() {
    std::lock_guard<std::mutex> lock(inkClientMutex());
    return !currentInkClient().expired();
}

QString bridgeStatus() {
    std::lock_guard<std::mutex> lock(bridgeStatusMutex());
    return bridgeStatusLine();
}

void setBridgeStatusHook(std::function<void()> fn) { bridgeStatusHook() = std::move(fn); }

}  // namespace cdl
