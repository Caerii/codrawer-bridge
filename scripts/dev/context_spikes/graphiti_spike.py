"""
Graphiti, tried local-first: embedded Kuzu, a local LLM and embedder through Ollama.

**The question** (docs/investigations/grounded-context.md §5): can Graphiti (getzep/graphiti, a
temporal knowledge graph built from "episodes" by LLM extraction) be the context graph without
heavy infrastructure, and what does an episode cost? This spike ingests four small episodes of the
kind codrawer would produce (a reading position, a Primer reading, an attempt, a note), counts the
LLM and embedding calls each makes, times them, and runs one search.

**Setup it needs.** `graphiti-core[kuzu]` (0.30.2 when written; it imports `httpx` without
declaring it, so add it), Ollama on 127.0.0.1:11434 with `qwen3:4b` (or `CODRAWER_GRAPHITI_LLM`)
and `nomic-embed-text`. Nothing leaves the machine. The graph is a Kuzu directory in the
scratch path given as the first argument.

Run:

    uv run --no-project --python 3.12 --with "graphiti-core[kuzu]" --with httpx \
      python scripts/dev/context_spikes/graphiti_spike.py <scratch dir>
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from openai import AsyncOpenAI

from graphiti_core import Graphiti
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
from graphiti_core.driver.kuzu_driver import KuzuDriver
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from graphiti_core.nodes import EpisodeType

OLLAMA = "http://127.0.0.1:11434/v1"
LLM = os.environ.get("CODRAWER_GRAPHITI_LLM", "qwen3:4b")
EMBED = "nomic-embed-text"

#: Episodes shaped like codrawer's own events (synthetic: no learner data).
EPISODES = [
    ("reading", "The learner opened Book of Proof, chapter 6 'Proof by Contradiction', section "
     "6.1, page 139, and read for 12 minutes. The section proves that the square root of 2 is "
     "irrational."),
    ("primer", "The Primer read the learner's handwritten proof that sqrt(2) is irrational. Step 6 "
     "concluded p and q are both even but the proof never assumed p/q in lowest terms "
     "(misconception: lowest_terms_missing). Concept: proof by contradiction. Score estimate 2/10."),
    ("attempt", "Practice coach: the learner attempted the folklore problem 'sqrt(3) is "
     "irrational' after reading section 6.1, used proof by contradiction with lowest terms, and "
     "scored an estimated 9/10 in 14 minutes with no hints."),
    ("note", "The learner tagged the page #contradiction and wrote: 'remember lowest terms, see "
     "Book of Proof Thm 6.1 p.139'."),
]


class Counter:
    """Counts HTTP requests by endpoint (chat completions vs embeddings) and their wall time."""

    def __init__(self) -> None:
        self.calls: dict[str, int] = {}
        self.tokens = {"prompt": 0, "completion": 0}

    async def on_response(self, r: httpx.Response) -> None:
        key = r.request.url.path.rsplit("/", 1)[-1]
        self.calls[key] = self.calls.get(key, 0) + 1
        if key == "completions":
            await r.aread()
            try:
                u = r.json().get("usage") or {}
                self.tokens["prompt"] += u.get("prompt_tokens", 0)
                self.tokens["completion"] += u.get("completion_tokens", 0)
            except (json.JSONDecodeError, ValueError):
                pass


async def main(scratch: Path) -> None:
    ctr = Counter()
    http = httpx.AsyncClient(timeout=600, event_hooks={"response": [ctr.on_response]})
    oa = AsyncOpenAI(base_url=OLLAMA, api_key="ollama", http_client=http)
    cfg = LLMConfig(api_key="ollama", model=LLM, small_model=LLM, base_url=OLLAMA)
    llm = OpenAIGenericClient(config=cfg, client=oa, max_tokens=4096)
    emb = OpenAIEmbedder(
        OpenAIEmbedderConfig(embedding_model=EMBED, embedding_dim=768, api_key="ollama", base_url=OLLAMA),
        client=oa,
    )
    rr = OpenAIRerankerClient(config=cfg, client=oa)
    scratch.mkdir(parents=True, exist_ok=True)
    driver = KuzuDriver(db=str(scratch / "graph.kuzu"))
    g = Graphiti(graph_driver=driver, llm_client=llm, embedder=emb, cross_encoder=rr)
    t0 = time.perf_counter()
    await g.build_indices_and_constraints()
    out: dict = {"llm": LLM, "embedder": EMBED, "setup_s": round(time.perf_counter() - t0, 2), "episodes": []}
    for name, body in EPISODES:
        before = dict(ctr.calls), dict(ctr.tokens)
        t = time.perf_counter()
        try:
            res = await g.add_episode(
                name=name, episode_body=body, source=EpisodeType.text,
                source_description="codrawer synthetic event", reference_time=datetime.now(timezone.utc),
            )
            nodes = [n.name for n in res.nodes]
            edges = [e.fact for e in res.edges]
            err = None
        except Exception as e:  # noqa: BLE001  (the spike records failures, it does not hide them)
            nodes, edges, err = [], [], f"{type(e).__name__}: {e}"[:300]
        dt = time.perf_counter() - t
        calls = {k: ctr.calls.get(k, 0) - before[0].get(k, 0) for k in ctr.calls}
        toks = {k: ctr.tokens[k] - before[1][k] for k in ctr.tokens}
        out["episodes"].append({"name": name, "s": round(dt, 1), "calls": calls, "tokens": toks,
                                "entities": nodes, "facts": edges, "error": err})
        print(json.dumps(out["episodes"][-1], ensure_ascii=False), flush=True)
    t = time.perf_counter()
    try:
        hits = await g.search("What should the learner remember about irrationality proofs?")
        out["search"] = {"s": round(time.perf_counter() - t, 2), "facts": [h.fact for h in hits[:5]]}
    except Exception as e:  # noqa: BLE001
        out["search"] = {"error": f"{type(e).__name__}: {e}"[:300]}
    print(json.dumps(out["search"], ensure_ascii=False))
    out_path = Path(__file__).parent / "results" / "graphiti.json"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    await g.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main(Path(sys.argv[1] if len(sys.argv) > 1 else "graphiti-scratch")))
