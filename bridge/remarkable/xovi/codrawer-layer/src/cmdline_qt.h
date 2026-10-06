// cmdline_qt.h: cmdline.h's grammar for the Qt side (commands take their words as a QStringList).
//
// The words are converted as UTF-8, so `arg` here is cmdline::arg: one implementation, tested on
// the host.
#pragma once

#include "cmdline.h"

#include <QtCore/QString>
#include <QtCore/QStringList>

#include <string>
#include <vector>

namespace cdl {

inline std::vector<std::string> toStdWords(const QStringList &words) {
    std::vector<std::string> out;
    out.reserve(size_t(words.size()));
    for (const QString &w : words) out.push_back(w.toStdString());
    return out;
}

inline QStringList fromStdWords(const std::vector<std::string> &words) {
    QStringList out;
    for (const std::string &w : words) out << QString::fromStdString(w);
    return out;
}

// The value of the first word `key=<value>` in a command's words, or an empty string.
inline QString arg(const QStringList &words, const char *key) {
    return QString::fromStdString(cmdline::arg(toStdWords(words), key));
}

}  // namespace cdl
