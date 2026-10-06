#!/bin/sh
# Tectonic on aarch64: does the static build run, how big is its cache, does it work offline?
#
# The question (docs/investigations/latex-on-tablet.md, spike 2): could the Paper Pro compile full
# LaTeX documents itself? Tectonic publishes a static aarch64-unknown-linux-musl build, which needs
# nothing from the tablet's glibc. This script times one amsmath document three times in a scratch
# cache: cold (downloads the bundle's files and builds the format), warm, and with --only-cached
# (no network: the offline case). Run it inside a Linux container, never on the tablet:
#
#   docker run --rm --platform linux/amd64 -v "$PWD:/w" debian:trixie-slim sh -c \
#     'apt-get update -qq && apt-get install -y -qq bc ca-certificates qemu-user-static >/dev/null;
#      sh /w/tectonic_bench.sh "qemu-aarch64-static /w/aarch64-unknown-linux-musl/tectonic"'
#
# with the release tarballs from https://github.com/tectonic-typesetting/tectonic/releases
# unpacked under ./<target>/. Under qemu-user the times prove the binary works, not how fast it is
# on a Cortex-A53; run the x86_64 musl build natively for the reference time.
set -u
TECTONIC=${1:?usage: tectonic_bench.sh "<tectonic command>"}
export XDG_CACHE_HOME=/cache
mkdir -p /tmp/tb && cd /tmp/tb
cat > math.tex <<'EOF'
\documentclass[11pt]{article}
\usepackage{amsmath,amssymb,amsthm}
\newtheorem*{claim}{Claim}
\begin{document}
\begin{claim} $\sqrt{2}\notin\mathbb{Q}$. \end{claim}
\begin{proof}
Suppose $\sqrt{2}=\tfrac{p}{q}$ with $p,q\in\mathbb{Z}$, $q\neq0$, in lowest terms. Then
\begin{align}
2q^2 &= p^2 \implies 2 \mid p \implies p = 2k,\\
2q^2 &= 4k^2 \implies q^2 = 2k^2 \implies 2 \mid q,
\end{align}
contradicting lowest terms. Also $\int_0^1 x^2\,dx=\frac13$ and $\sum_{n\ge1}\frac{1}{n^2}=\frac{\pi^2}{6}$.
\end{proof}
\end{document}
EOF
run() { label=$1; shift; s=$(date +%s.%N); $TECTONIC -X compile "$@" math.tex >"$label.log" 2>&1; rc=$?
        e=$(date +%s.%N); echo "$label: $(echo "$e - $s" | bc) s rc=$rc"; }
run cold
run warm
run offline --only-cached
ls -l math.pdf
du -sh /cache/tectonic/*
