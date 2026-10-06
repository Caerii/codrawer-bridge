// cmdline.h: the word grammar of the command file and of inject.conf, as pure functions.
//
// Two text channels reach the extension as lines of words: the probe command file
// (/tmp/codrawer-layer/cmd, commands.cpp) and inject.conf (inject.cpp). Both read a line as
// `verb key=value key=value …`. This header is that grammar with no Qt, so the host tests
// (tests/cmdline_test.cpp, run by test.sh) check the code the extension runs.
//
// The rules are those of the Qt calls the extension used before this header existed, kept
// exactly:
//
//   splitLines(text)  QString::split('\n', Qt::SkipEmptyParts): every part between '\n's that is
//                     not empty; a part of only spaces is kept (trim decides later).
//   trim(s)           QString::trimmed(): leading and trailing white space as QChar::isSpace
//                     sees it, which is ASCII \t \n \v \f \r and space plus the Unicode spaces
//                     (U+0085, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F,
//                     U+3000). The text is UTF-8 here, so those are matched as byte sequences.
//   words(line)       QString::split(' ', Qt::SkipEmptyParts): split on the space character only
//                     (a tab stays inside a word).
//   arg(words, key)   the value of the first word that starts with `key=`, or "".
//
// Splitting UTF-8 bytes on '\n' and ' ' gives the same parts as splitting the decoded text:
// neither byte occurs inside a multi-byte sequence.
#pragma once

#include <string>
#include <vector>

namespace cmdline {

// Length in bytes of the white-space character (QChar::isSpace) starting at s[i], or 0.
inline size_t spaceAt(const std::string &s, size_t i) {
    const auto b = [&s](size_t k) { return k < s.size() ? static_cast<unsigned char>(s[k]) : 0u; };
    const unsigned c = b(i);
    if (c == ' ' || (c >= '\t' && c <= '\r')) return 1;
    if (c == 0xC2 && (b(i + 1) == 0x85 || b(i + 1) == 0xA0)) return 2;  // U+0085, U+00A0
    if (c == 0xE1 && b(i + 1) == 0x9A && b(i + 2) == 0x80) return 3;    // U+1680
    if (c == 0xE2 && b(i + 1) == 0x80) {
        const unsigned d = b(i + 2);
        if ((d >= 0x80 && d <= 0x8A) || d == 0xA8 || d == 0xA9 || d == 0xAF) return 3;  // U+2000..200A, 2028, 2029, 202F
    }
    if (c == 0xE2 && b(i + 1) == 0x81 && b(i + 2) == 0x9F) return 3;  // U+205F
    if (c == 0xE3 && b(i + 1) == 0x80 && b(i + 2) == 0x80) return 3;  // U+3000
    return 0;
}

// Length of the white-space character that ends at s[end - 1] (end exclusive), or 0.
inline size_t spaceBefore(const std::string &s, size_t end) {
    for (size_t len = 1; len <= 3 && len <= end; ++len) {
        if (spaceAt(s, end - len) == len) return len;
    }
    return 0;
}

inline std::string trim(const std::string &s) {
    size_t a = 0, b = s.size();
    for (size_t n; a < b && (n = spaceAt(s, a)) > 0;) a += n;
    for (size_t n; b > a && (n = spaceBefore(s, b)) > 0;) b -= n;
    return s.substr(a, b - a);
}

inline std::vector<std::string> split(const std::string &s, char sep) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = 0; i <= s.size(); ++i) {
        if (i == s.size() || s[i] == sep) {
            if (i > start) out.push_back(s.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

inline std::vector<std::string> splitLines(const std::string &text) { return split(text, '\n'); }

inline std::vector<std::string> words(const std::string &line) { return split(line, ' '); }

inline std::string arg(const std::vector<std::string> &words, const std::string &key) {
    const std::string k = key + '=';
    for (const std::string &w : words) {
        if (w.compare(0, k.size(), k) == 0) return w.substr(k.size());
    }
    return std::string();
}

}  // namespace cmdline
