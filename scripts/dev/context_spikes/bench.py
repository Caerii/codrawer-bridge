"""
Time the library spike and score its citations against gold answers.

**What it measures** (docs/investigations/grounded-context.md §3, §6):

- *Ingestion*: PDF open, text + outline + units + chunks + FTS5 (one stage), embedding model load,
  embedding (GPU when `--gpu`), and the index size on disk.
- *Query latency*, warm, over the gold questions repeated: FTS5 alone, vector alone, hybrid (RRF),
  and the `@` completion lookup, as p50 / p95 in ms. Targets: `@` completion under 50 ms, a
  grounded retrieval well under the model call it precedes.
- *Citation quality* on `gold_bookofproof.json`: for in-corpus questions, hit@1 and hit@5 (a cited
  page lies inside a gold outline section), precision@5 (the share of the five citations that
  do) and MRR; for out-of-corpus questions, whether a distance threshold on the best vector hit
  abstains ("not in your sources"). The threshold is chosen on this fixture, so the abstention
  numbers are optimistic; they show separation, not a calibrated rate.

Run (GPU embedding, as on aleph-desktop):

    uv run --no-project --python 3.12 --with pymupdf --with sqlite-vec --with fastembed-gpu \
      --with "onnxruntime-gpu[cuda,cudnn]" python scripts/dev/context_spikes/bench.py BOOK.pdf --gpu

Without `--gpu`, swap the last two `--with` for `--with fastembed`.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from library import Searcher, ingest  # noqa: E402

HERE = Path(__file__).parent


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(p * len(xs)))], 2)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--db", default="bench.sqlite")
    ap.add_argument("--gpu", action="store_true")
    ap.add_argument("--gold", type=Path, default=HERE / "gold_bookofproof.json")
    ap.add_argument("--out", type=Path, default=HERE / "results" / "bench.json")
    a = ap.parse_args()

    if os.path.exists(a.db):
        os.remove(a.db)
    tm = ingest(a.pdf, a.db, embed=True, gpu=a.gpu)
    report: dict = {
        "pdf_mb": round(a.pdf.stat().st_size / 1e6, 2),
        "ingest_s": tm.stages,
        "counts": tm.counts,
        "db_mb": round(os.path.getsize(a.db) / 1e6, 2),
        "embedding": "bge-small-en-v1.5 " + ("GPU (CUDA)" if a.gpu else "CPU"),
    }

    s = Searcher(a.db, gpu=a.gpu)
    gold = json.loads(a.gold.read_text(encoding="utf-8"))["questions"]

    def gold_pages(sections: list[str]) -> set[int]:
        pages: set[int] = set()
        for title in sections:
            for st, en in s.con.execute(
                "select start_idx, end_idx from section where title=?", (title,)
            ):
                pages |= set(range(st, en + 1))
        return pages

    # warm-up, then latency
    s.search("warm up")
    s.search("warm up", mode="rerank")
    lat: dict[str, list[float]] = {"fts": [], "vec": [], "hybrid": [], "rerank": [], "complete": []}
    for _ in range(5):
        for g in gold:
            for mode in ("fts", "vec", "hybrid", "rerank"):
                t0 = time.perf_counter()
                s.search(g["q"], mode=mode)
                lat[mode].append((time.perf_counter() - t0) * 1000)
        for pre in ("pig", "contra", "theorem 6", "def", "induc", "power", "fact 3"):
            t0 = time.perf_counter()
            s.complete(pre)
            lat["complete"].append((time.perf_counter() - t0) * 1000)
    report["latency_ms"] = {m: {"p50": pct(v, 0.5), "p95": pct(v, 0.95), "n": len(v)} for m, v in lat.items()}

    # citation quality
    quality: dict[str, dict] = {}
    best_dist_in, best_dist_out = [], []
    per_q = []
    for mode in ("fts", "vec", "hybrid", "rerank"):
        h1 = h5 = 0
        prec, rr = [], []
        for g in gold:
            if g.get("out_of_corpus"):
                continue
            gp = gold_pages(g["gold_sections"])
            hits = s.search(g["q"], k=5, mode=mode)
            ok = [h.page_idx in gp for h in hits]
            h1 += bool(ok and ok[0])
            h5 += any(ok)
            prec.append(sum(ok) / max(1, len(ok)))
            rr.append(next((1 / (i + 1) for i, o in enumerate(ok) if o), 0.0))
            if mode == "rerank":
                per_q.append({"q": g["q"], "ok@5": ok, "top": hits[0].cite() if hits else None})
        n = len(prec)
        quality[mode] = {
            "hit@1": round(h1 / n, 3), "hit@5": round(h5 / n, 3),
            "precision@5": round(statistics.mean(prec), 3), "mrr": round(statistics.mean(rr), 3), "n": n,
        }
    for g in gold:
        d = s.vec(g["q"], k=1)
        (best_dist_out if g.get("out_of_corpus") else best_dist_in).append(round(d[0][1], 4) if d else 9.0)
    # abstention: the threshold that best separates the two sets (fit on this fixture)
    cands = sorted(set(best_dist_in + best_dist_out))
    best = max(
        cands,
        key=lambda t: sum(x <= t for x in best_dist_in) + sum(x > t for x in best_dist_out),
    )
    report["quality"] = quality
    report["abstention"] = {
        "best_vec_distance_in_corpus": sorted(best_dist_in),
        "best_vec_distance_out_of_corpus": sorted(best_dist_out),
        "threshold_fit_here": best,
        "answered_in_corpus": f"{sum(x <= best for x in best_dist_in)}/{len(best_dist_in)}",
        "abstained_out_of_corpus": f"{sum(x > best for x in best_dist_out)}/{len(best_dist_out)}",
    }
    report["rerank_per_question"] = per_q
    a.out.parent.mkdir(exist_ok=True)
    a.out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "rerank_per_question"}, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
