"""
Practice: the problem bank, timed sessions, the queue the learner model chooses, and the plan.

**The problem.** The first learner is preparing for the 87th Putnam, on Saturday 5 December 2026,
about two months from when this was written. From that exam on the Putnam is **four 90-minute
sessions of three problems each**, twelve problems scored 0–10, 120 points in all, sat
synchronously across time zones (Eastern 11:00–12:30, 12:45–14:15, 16:00–17:30, 17:45–19:15;
maa.org/putnam, and e.g. math.gatech.edu/putnam-competition). It was two three-hour sessions of
six. Practice has to match the new shape: 30 minutes per problem on average, so triage (read all
three first, attack the most tractable, decide when to write up partial progress) is a skill to
train, and a full mock is four sessions with the real breaks.

**What is here.**

- :data:`BANK`: problems written in our own words: classic folklore exercises whose ideas belong
  to everyone (no competition solution text is bundled). Each is tagged with concepts
  (concepts.py), a difficulty 1–5, and a *key idea* the debrief reveals only after an attempt.
- :func:`putnam_ref`: past Putnam problems **by reference only**, ``Putnam 1995 B1``, with a
  pointer to the archive (Kiran Kedlaya's, kskedlaya.org/putnam-archive). Their A1–A6 / B1–B6
  labels place them on the *old* two-session ladder, where 1 tended to be easiest and 6 hardest.
  How difficulty will be spread within a new three-problem session is not known from past data,
  so nothing here assumes a ladder: practice sessions mix difficulties in shuffled order.
- :func:`choose_queue`: the next problems, chosen by the learner model: *stretch* problems whose
  predicted success sits in a band around 0.35–0.75 (hard enough to need effort, not hopeless:
  the zone of proximal development; Wilson, Shenhav, Straccia & Cohen 2019, "The eighty five
  percent rule for optimal learning", *Nature Communications*, argue for practice at moderate
  error rates), *review* problems on concepts the half-life model says are fading
  (learner.due), *weakness* problems on the concepts behind recurring misconceptions (a fresh
  problem with the same idea), and *reading* problems tied to the textbook section she was just
  in (coach.py).
  Every pick carries a ``why`` line: the coach must be inspectable (ADR 010).
- :func:`timed_session` and :func:`mock_exam`: a 90-minute three-problem set, and four of them
  with the exam's break pattern.
- :func:`plan`: a weekly plan from now to the exam with topics, problem counts and full mocks on
  fixed Saturdays, re-weighted by mastery each time it is built.

Times are minutes unless named ``_ms``; dates are ISO ``YYYY-MM-DD`` strings in local time.
"""

from __future__ import annotations

# ruff: noqa: E501  (catalog prose and prompt text read better unwrapped)
import datetime as dt
import random
from dataclasses import dataclass, field

from .concepts import AREA_LABELS, AREAS, CONCEPTS, MISCONCEPTIONS
from .learner import Learner

#: The 87th Putnam (expected date; confirm at maa.org/putnam).
EXAM_DATE = "2026-12-05"
SESSION_MINUTES = 90
PROBLEMS_PER_SESSION = 3
#: The exam day's four sessions, Eastern time, and the breaks between them (minutes).
EXAM_SESSIONS = (("11:00", "12:30"), ("12:45", "14:15"), ("16:00", "17:30"), ("17:45", "19:15"))
EXAM_BREAKS = (15, 105, 15)
ARCHIVE_URL = "https://kskedlaya.org/putnam-archive/"


# =============================================================================================
# The bank
# =============================================================================================


@dataclass(frozen=True)
class Problem:
    """
    A practice problem. ``statement`` is in our own words; ``key_idea`` is withheld until the
    debrief. ``difficulty`` 1 (a first proof) to 5 (a hard competition problem). ``source`` is
    ``folklore`` for the bank, ``putnam`` for an archive reference (then ``statement`` is only a
    pointer). ``sections`` are keywords that tie a problem to textbook sections (coach.py).
    """

    id: str
    title: str
    statement: str
    concepts: tuple[str, ...]
    difficulty: int
    key_idea: str = ""
    source: str = "folklore"
    sections: tuple[str, ...] = field(default=())


def _p(
    id: str,
    title: str,
    statement: str,
    concepts: tuple[str, ...],
    difficulty: int,
    key_idea: str,
    sections: tuple[str, ...] = (),
) -> Problem:
    return Problem(id, title, statement, concepts, difficulty, key_idea, "folklore", sections)


BANK: dict[str, Problem] = {
    p.id: p
    for p in [
        # Onboarding: the three fixture proofs (fixtures/).
        _p(
            "sqrt2_irrational",
            "√2 is irrational",
            "Prove that there are no integers p, q with q ≠ 0 and (p/q)² = 2.",
            ("irrationality", "contradiction", "rationality", "square_parity", "parity"),
            1,
            "Write p/q in lowest terms; show 2 divides both p and q.",
            ("irrational", "rational", "real numbers"),
        ),
        _p(
            "odd_sum_squares",
            "Sums of odd numbers",
            "Prove that the sum of the first n odd positive integers is n².",
            ("induction",),
            1,
            "Induct on n: adding the next odd number 2n+1 turns n² into (n+1)².",
            ("induction",),
        ),
        # Techniques
        _p(
            "pigeonhole_square",
            "Five points in a square",
            "Five points lie in a square of side 2. Prove two of them are at distance at most √2.",
            ("pigeonhole",),
            2,
            "Cut the square into four unit squares; two points share one.",
            ("pigeonhole",),
        ),
        _p(
            "domino_corners",
            "Dominoes on a clipped board",
            "Two opposite corner squares are removed from an 8×8 board. Can the rest be tiled by 1×2 dominoes?",
            ("coloring", "invariants"),
            2,
            "Every domino covers one black and one white square; the removed corners share a colour.",
            ("coloring", "invariants"),
        ),
        _p(
            "chips_monovariant",
            "Splitting piles",
            "A pile of n stones is split repeatedly into two piles, and each split of a+b scores ab. Show the total score does not depend on the splits.",
            ("invariants", "induction"),
            3,
            "Track Σ (pile sizes choose 2): each split adds exactly ab.",
            ("invariants",),
        ),
        _p(
            "extremal_points",
            "Separating points",
            "Finitely many points in the plane are not all on one line. Prove some line passes through exactly two of them.",
            ("extremal_principle", "contradiction"),
            4,
            "Take the point-line pair at least positive distance; it cannot have three points.",
            ("extremal",),
        ),
        _p(
            "strong_induction_stamps",
            "Postage",
            "Prove every integer amount of at least 12 cents can be paid with 4- and 5-cent stamps.",
            ("strong_induction",),
            2,
            "Check 12–15, then n = (n−4) + 4.",
            ("induction",),
        ),
        _p(
            "handshake",
            "Handshakes",
            "Prove that at any party the number of people who shook an odd number of hands is even.",
            ("graph_basics", "parity", "double_counting"),
            2,
            "The degrees sum to twice the number of handshakes.",
            ("graphs",),
        ),
        # Number theory
        _p(
            "squares_mod_4",
            "Sums of two squares",
            "Prove that no integer of the form 4k+3 is a sum of two squares.",
            ("modular_arithmetic", "cases"),
            2,
            "Squares are 0 or 1 mod 4.",
            ("congruences", "modular"),
        ),
        _p(
            "infinitely_many_primes",
            "Infinitely many primes",
            "Prove there are infinitely many primes.",
            ("primes", "contradiction"),
            1,
            "Any finite list p₁…pₙ misses every prime factor of p₁⋯pₙ + 1.",
            ("primes",),
        ),
        _p(
            "fermat_divides",
            "A divisibility",
            "Prove that 7 divides 2^(3n) − 1 for every n ≥ 1, then that 13 divides 3^(3n) − 1.",
            ("modular_arithmetic", "orders"),
            2,
            "2³ ≡ 1 (mod 7) and 3³ ≡ 1 (mod 13).",
            ("congruences", "fermat"),
        ),
        _p(
            "order_divides",
            "Orders divide",
            "Let p be prime and a an integer not divisible by p. If a^k ≡ 1 (mod p), prove the order of a divides k.",
            ("orders", "gcd"),
            3,
            "Write k = qd + r with d the order and 0 ≤ r < d.",
            ("order", "fermat"),
        ),
        _p(
            "gcd_consecutive_fib",
            "Consecutive Fibonacci numbers",
            "Prove consecutive Fibonacci numbers are coprime.",
            ("gcd", "induction"),
            2,
            "gcd(Fₙ₊₁, Fₙ) = gcd(Fₙ, Fₙ₋₁).",
            ("gcd", "euclid"),
        ),
        _p(
            "sqrt3_irrational",
            "√3 is irrational",
            "Prove that √3 is irrational.",
            ("irrationality", "modular_arithmetic", "contradiction"),
            2,
            "Lowest terms again; replace parity by divisibility by 3.",
            ("irrational",),
        ),
        # Inequalities
        _p(
            "am_gm_two",
            "Two-term AM-GM",
            "Prove (a+b)/2 ≥ √(ab) for a, b ≥ 0, with equality exactly when a = b.",
            ("am_gm", "equality_cases"),
            1,
            "(√a − √b)² ≥ 0.",
            ("inequalities", "am-gm"),
        ),
        _p(
            "cs_sum_reciprocal",
            "A reciprocal sum",
            "For positive x₁…xₙ, prove (x₁+⋯+xₙ)(1/x₁+⋯+1/xₙ) ≥ n².",
            ("cauchy_schwarz", "am_gm"),
            2,
            "Cauchy-Schwarz with aᵢ = √xᵢ, bᵢ = 1/√xᵢ.",
            ("cauchy", "inequalities"),
        ),
        _p(
            "jensen_sine",
            "Sines of a triangle",
            "Prove sin A + sin B + sin C ≤ 3√3/2 for the angles of a triangle.",
            ("jensen", "equality_cases"),
            3,
            "sin is concave on [0, π].",
            ("convex", "jensen"),
        ),
        _p(
            "rearrangement_basic",
            "Rearranged products",
            "For reals a ≤ b ≤ c and x ≤ y ≤ z, prove ax+by+cz ≥ ay+bz+cx.",
            ("rearrangement",),
            2,
            "Pairing sorted with sorted maximizes the sum.",
            ("rearrangement",),
        ),
        # Polynomials
        _p(
            "vieta_sum_squares",
            "Squares of roots",
            "The roots of x³ − 3x² + 5x − 7 are r, s, t. Find r² + s² + t² without solving.",
            ("vieta",),
            1,
            "(r+s+t)² − 2(rs+st+tr).",
            ("polynomials", "vieta"),
        ),
        _p(
            "integer_poly_values",
            "Integer polynomial values",
            "A polynomial with integer coefficients takes the value 5 at four distinct integers. Prove it never takes the value 8 at an integer.",
            ("polynomial_roots", "divisibility"),
            4,
            "p(x) − 5 = (x−a)(x−b)(x−c)(x−d)q(x); 3 is not a product of four distinct integers times an integer.",
            ("polynomials",),
        ),
        _p(
            "eisenstein_basic",
            "Irreducible",
            "Prove x⁴ + 10x + 5 is irreducible over the rationals.",
            ("irreducibility",),
            2,
            "Eisenstein at 5.",
            ("irreducible", "polynomials"),
        ),
        # Combinatorics
        _p(
            "subsets_bijection",
            "Even and odd subsets",
            "Prove a nonempty finite set has as many subsets of even size as of odd size.",
            ("bijections", "binomial"),
            2,
            "Toggle a fixed element: an involution swapping parities.",
            ("bijection", "subsets"),
        ),
        _p(
            "double_count_binom",
            "A binomial identity",
            "Prove Σₖ k·C(n,k) = n·2ⁿ⁻¹ by counting one set two ways.",
            ("double_counting", "binomial"),
            2,
            "Count (committee, chair) pairs.",
            ("binomial", "counting"),
        ),
        _p(
            "derangements_ie",
            "Derangements",
            "Count the permutations of {1,…,n} with no fixed point.",
            ("inclusion_exclusion",),
            3,
            "Inclusion-exclusion over the fixed points.",
            ("inclusion", "permutations"),
        ),
        _p(
            "gf_partitions",
            "Odd and distinct parts",
            "Prove the number of partitions of n into odd parts equals the number into distinct parts.",
            ("generating_functions", "bijections"),
            4,
            "Π(1+xᵏ) = Π 1/(1−x²ᵏ⁻¹).",
            ("generating functions", "partitions"),
        ),
        _p(
            "recurrence_tilings",
            "Tilings",
            "Count tilings of a 2×n strip by 1×2 dominoes.",
            ("recurrences",),
            2,
            "Fibonacci: the first column is one vertical or two horizontal dominoes.",
            ("recurrence",),
        ),
        # Linear algebra
        _p(
            "det_parity",
            "An odd determinant",
            "An n×n matrix has 0 on the diagonal and odd integers elsewhere, n even. Prove its determinant is nonzero.",
            ("determinant_parity", "determinants"),
            4,
            "Mod 2 it is J − I, whose determinant is odd when n is even.",
            ("determinant",),
        ),
        _p(
            "rank_ab",
            "Rank of a product",
            "Prove rank(AB) ≤ min(rank A, rank B).",
            ("rank",),
            2,
            "The image of AB lies in the image of A; the kernel of B lies in the kernel of AB.",
            ("rank",),
        ),
        _p(
            "eigen_nilpotent",
            "Nilpotent matrices",
            "If Aᵏ = 0 for some k, prove every eigenvalue of A is 0 and I − A is invertible.",
            ("eigenvalues",),
            3,
            "Av = λv gives Aᵏv = λᵏv; (I−A)(I+A+⋯+Aᵏ⁻¹) = I.",
            ("eigenvalue",),
        ),
        # Analysis
        _p(
            "mvt_bound",
            "A sine bound",
            "Prove |sin x − sin y| ≤ |x − y| for all real x, y.",
            ("mvt",),
            2,
            "The mean value theorem with |cos| ≤ 1.",
            ("mean value",),
        ),
        _p(
            "ivt_fixed_point",
            "A fixed point",
            "A continuous f maps [0,1] into [0,1]. Prove f(c) = c for some c.",
            ("continuity",),
            2,
            "Apply the IVT to f(x) − x.",
            ("continuity", "intermediate value"),
        ),
        _p(
            "harmonic_diverges",
            "The harmonic series",
            "Prove Σ 1/n diverges.",
            ("series",),
            1,
            "Group terms in blocks of length 2ᵏ, each at least 1/2.",
            ("series",),
        ),
        _p(
            "integral_symmetry",
            "A symmetric integral",
            "Evaluate ∫₀^{π/2} sinⁿx / (sinⁿx + cosⁿx) dx.",
            ("integrals", "symmetry"),
            2,
            "Substitute x ↦ π/2 − x and add.",
            ("integral",),
        ),
        _p(
            "monotone_sequence",
            "A recursive sequence",
            "Let a₁ = 1 and aₙ₊₁ = √(2 + aₙ). Prove the sequence converges and find its limit.",
            ("sequences", "induction"),
            2,
            "Bounded by 2 and increasing, by induction; the limit solves L = √(2+L).",
            ("sequence", "limits"),
        ),
        # Probability
        _p(
            "fixed_points_expectation",
            "Fixed points",
            "Find the expected number of fixed points of a uniformly random permutation of {1,…,n}.",
            ("expectation",),
            1,
            "Linearity: each point is fixed with probability 1/n.",
            ("expectation", "probability"),
        ),
        _p(
            "broken_stick",
            "A broken stick",
            "A stick is broken at two uniformly random points. Find the probability the three pieces form a triangle.",
            ("geometric_probability",),
            3,
            "The triangle region is a quarter of the square.",
            ("probability", "geometric"),
        ),
        # Functional equations
        _p(
            "cauchy_rationals",
            "Additive functions",
            "f: ℚ → ℚ satisfies f(x+y) = f(x) + f(y). Prove f(x) = cx for some c.",
            ("cauchy_equation",),
            3,
            "f(n) = nf(1) by induction, then f(m/n) by scaling.",
            ("functional",),
        ),
        _p(
            "fe_substitution",
            "A substitution",
            "Find all f: ℝ → ℝ with f(x) + 2f(1−x) = x² for all x.",
            ("functional_equations",),
            2,
            "Replace x by 1−x and solve the 2×2 system; then check.",
            ("functional",),
        ),
        # Complex
        _p(
            "roots_unity_sum",
            "Roots of unity",
            "Prove the n-th roots of unity sum to 0 for n ≥ 2.",
            ("roots_of_unity",),
            1,
            "Multiply the sum by ω ≠ 1: it is unchanged.",
            ("roots of unity", "complex"),
        ),
        _p(
            "roots_unity_filter",
            "Every third binomial",
            "Compute C(n,0) + C(n,3) + C(n,6) + ⋯ in closed form.",
            ("roots_of_unity", "binomial"),
            4,
            "Average (1+ωʲ)ⁿ over the cube roots of unity.",
            ("roots of unity", "binomial"),
        ),
    ]
}


def putnam_ref(year: int, session: str, number: int) -> Problem:
    """
    A past Putnam problem by reference: no statement or solution text, only where to read it.
    ``session`` is ``A`` or ``B``; ``number`` 1–6 (the pre-2026 two-session labels). Concepts are
    unknown until she tags them in a debrief (the notebook records what worked).
    """
    if session not in ("A", "B") or not 1 <= number <= 6:
        raise ValueError("Putnam problems are A1–A6 or B1–B6")
    return Problem(
        id=f"putnam_{year}_{session}{number}",
        title=f"Putnam {year} {session}{number}",
        statement=f"Read Putnam {year} {session}{number} in the archive ({ARCHIVE_URL}); write your solution on the page.",
        concepts=(),
        difficulty=0,
        source="putnam",
    )


# =============================================================================================
# Choosing problems
# =============================================================================================


def predicted_success(learner: Learner, p: Problem) -> float:
    """
    A rough probability she solves ``p``: the product of her mastery of its concepts, raised to a
    difficulty exponent (difficulty 1 → 0.6, 5 → 1.8), so hard problems need more than knowing
    the parts. A heuristic for ranking, not a calibrated model.
    """
    prob = 1.0
    for c in p.concepts:
        prob *= learner.mastery(c) if c in CONCEPTS else 0.5
    return prob ** (0.3 * max(1, p.difficulty) + 0.3)


@dataclass
class Pick:
    """A queued problem and why the coach chose it (shown on every suggestion)."""

    problem: str
    title: str
    why: str
    kind: str  # reading | review | weakness | stretch | warmup
    p_success: float

    def to_dict(self) -> dict:
        return {
            "id": self.problem,
            "title": self.title,
            "why": self.why,
            "kind": self.kind,
            "p": round(self.p_success, 2),
        }


def choose_queue(
    learner: Learner, now_ms: float, n: int = 5, reading_keywords: list[str] | None = None
) -> list[Pick]:
    """
    The next ``n`` problems for ``learner``, in this order: up to two tied to the textbook
    section she was just reading (when a bank problem matches), up to two spaced-review problems
    on fading concepts, up to two aimed at weak spots (recurring misconceptions, low mastery),
    then stretch problems nearest the middle of the 0.35–0.75 success band. Problems already
    solved with 8 or more are skipped. Each pick names its reason.
    """
    done = {pid for pid, s in learner.solved.items() if s >= 8}
    due = set(learner.due(now_ms))
    picks: list[Pick] = []
    used: set[str] = set()

    def add(p: Problem, why: str, kind: str) -> None:
        if p.id in used or p.id in done or len(picks) >= n:
            return
        used.add(p.id)
        picks.append(Pick(p.id, p.title, why, kind, predicted_success(learner, p)))

    if reading_keywords:
        kws = [k.lower() for k in reading_keywords if k]
        for p in BANK.values():
            hit = next((k for k in kws for s in p.sections if s in k or k in s), None)
            if hit:
                add(p, f"Matches what you were just reading ({hit}).", "reading")
                if sum(1 for x in picks if x.kind == "reading") >= 2:
                    break

    for c in learner.due(now_ms):
        cands = sorted((p for p in BANK.values() if c in p.concepts), key=lambda p: p.difficulty)
        for p in cands:
            if p.id not in used and p.id not in done:
                label = CONCEPTS[c].label if c in CONCEPTS else c
                add(p, f"Spaced review: {label} is fading (last practised a while ago).", "review")
                break
        if sum(1 for x in picks if x.kind == "review") >= 2:
            break

    # Weak spots: the concepts behind recurring misconceptions, and concepts with repeated low
    # evidence, each get the easiest unsolved problem that exercises them, preferring one she has
    # not tried (the same idea on a fresh problem, not the one she just failed).
    weak: list[tuple[float, str]] = []
    for mid, ms in learner.misconceptions.items():
        if ms.recurring and mid in MISCONCEPTIONS:
            for c in MISCONCEPTIONS[mid].concepts:
                weak.append((learner.mastery(c) - 0.1 * ms.count, c))
    for cid, st in learner.concepts.items():
        if st.opportunities >= 2 and st.p < 0.5:
            weak.append((st.p, cid))
    targeted: set[str] = set()
    for _, c in sorted(weak):
        if c in targeted or c not in CONCEPTS:
            continue
        targeted.add(c)
        cands = sorted(
            (p for p in BANK.values() if c in p.concepts),
            key=lambda p: (p.id in learner.seen, p.difficulty),
        )
        for p in cands:
            if p.id not in used and p.id not in done:
                add(
                    p,
                    f"Targets a weak spot: {CONCEPTS[c].label} (mastery {learner.mastery(c):.2f}).",
                    "weakness",
                )
                break
        if sum(1 for x in picks if x.kind == "weakness") >= 2:
            break

    scored = []
    for p in BANK.values():
        s = predicted_success(learner, p)
        scored.append((abs(s - 0.55), -len(set(p.concepts) & due), p, s))
    scored.sort(key=lambda t: (t[0], t[1], t[2].id))
    for _, _, p, s in scored:
        weakest = min(p.concepts, key=lambda c: learner.mastery(c)) if p.concepts else ""
        label = CONCEPTS[weakest].label if weakest in CONCEPTS else weakest
        if 0.35 <= s <= 0.75:
            add(
                p,
                f"At the edge of what you can do: about a {round(100 * s)}% chance, stretches {label}.",
                "stretch",
            )
        elif s > 0.75 and len(picks) < n and p.difficulty >= 3:
            add(
                p,
                f"Should be within reach ({round(100 * s)}%); a confidence check on {label}.",
                "warmup",
            )
    for _, _, p, _s in scored:  # top up when the band is empty (a new learner)
        if len(picks) >= n:
            break
        add(
            p,
            f"A starting point for {', '.join(CONCEPTS[c].label for c in p.concepts[:2] if c in CONCEPTS)}.",
            "stretch",
        )
    return picks


# =============================================================================================
# Timed sessions and mocks
# =============================================================================================


def timed_session(learner: Learner, now_ms: float, seed: int | None = None) -> dict:
    """
    A 90-minute, three-problem session: one problem she should be able to finish, one at her
    edge, one beyond it, in shuffled order (the new format's within-session difficulty is not
    known, ADR 010, so position must not signal difficulty). Comes with the triage plan the
    policy coaches (policy.pacing_nudge).
    """
    rng = random.Random(seed)
    unsolved = [p for p in BANK.values() if learner.solved.get(p.id, 0) < 8]
    by_s = sorted(unsolved, key=lambda p: predicted_success(learner, p))
    if len(by_s) < 3:
        by_s = sorted(BANK.values(), key=lambda p: predicted_success(learner, p))
    hard, mid, easy = by_s[len(by_s) // 6], by_s[len(by_s) // 2], by_s[-1 - len(by_s) // 8]
    probs = [easy, mid, hard]
    rng.shuffle(probs)
    return {
        "kind": "session",
        "minutes": SESSION_MINUTES,
        "problems": [{"id": p.id, "title": p.title, "statement": p.statement} for p in probs],
        "triage": [
            "Minutes 0–5: read all three; note an idea for each.",
            "Start with the one you can most likely finish.",
            "Around minute 30: if it is not converging, write up what you have and move on.",
            "Last 10 minutes: write up partial progress cleanly; graders reward rigorous partial work.",
        ],
    }


def mock_exam(learner: Learner, now_ms: float, seed: int | None = None) -> dict:
    """A full mock: four timed sessions with the exam's break pattern (15, 105, 15 minutes)."""
    sessions = [timed_session(learner, now_ms, seed=(seed or 0) + i) for i in range(4)]
    return {
        "kind": "mock",
        "sessions": sessions,
        "breaks": list(EXAM_BREAKS),
        "schedule": [list(s) for s in EXAM_SESSIONS],
    }


# =============================================================================================
# The plan
# =============================================================================================

#: The base sequence of weekly focus areas; the last two weeks are filled from her weaknesses.
BASE_WEEKS: tuple[tuple[str, ...], ...] = (
    ("logic", "techniques"),
    ("number_theory",),
    ("inequalities", "polynomials"),
    ("combinatorics",),
    ("linear_algebra", "complex"),
    ("analysis",),
    ("probability", "functional_equations"),
)


def _saturdays(start: dt.date, end: dt.date) -> list[dt.date]:
    d = start + dt.timedelta(days=(5 - start.weekday()) % 7)
    out = []
    while d < end:
        out.append(d)
        d += dt.timedelta(days=7)
    return out


def area_mastery(learner: Learner, area: str) -> float:
    """Mean mastery over the area's concepts (priors included)."""
    cs = [c for c in CONCEPTS.values() if c.area == area]
    return sum(learner.mastery(c.id) for c in cs) / max(1, len(cs))


def area_evidence_mastery(learner: Learner, area: str) -> float | None:
    """Mean mastery over the area's concepts that have evidence; None when none has any yet."""
    ps = [
        st.p
        for cid, st in learner.concepts.items()
        if st.opportunities and cid in CONCEPTS and CONCEPTS[cid].area == area
    ]
    return sum(ps) / len(ps) if ps else None


def plan(learner: Learner, today: str, exam: str = EXAM_DATE) -> dict:
    """
    The weekly plan from ``today``'s week to the exam: each week's focus areas, a problem count
    (four timed sessions' worth, twelve, plus review), and full four-session mocks on three fixed
    Saturdays spread through the run (with no mock in the final week, which tapers). The base
    sequence (:data:`BASE_WEEKS`) visits every area once; the weeks left after it go to her two
    weakest areas by mean mastery, and any area under 0.4 is added as review to later weeks.
    """
    t = dt.date.fromisoformat(today)
    e = dt.date.fromisoformat(exam)
    monday = t - dt.timedelta(days=t.weekday())
    weeks_n = max(1, (e - monday).days // 7 + 1)
    sats = [s for s in _saturdays(t, e) if s > t]
    # Three full mocks, two weeks apart, the last on the Saturday a week before the exam's (so
    # the final week tapers): 24 Oct, 7 Nov and 21 Nov for the 2026 exam planned from October.
    mocks: set[dt.date] = {sats[k] for k in (-2, -4, -6) if len(sats) >= -k}
    weak = sorted(AREAS, key=lambda a: area_mastery(learner, a))
    seq = list(BASE_WEEKS)
    while len(seq) < weeks_n - 1:
        seq.append(tuple(weak[:2]))
    weeks = []
    for i in range(weeks_n):
        start = monday + dt.timedelta(days=7 * i)
        end = start + dt.timedelta(days=6)
        last = i == weeks_n - 1
        focus = ("review",) if last else seq[min(i, len(seq) - 1)]
        visited = {a for wk in seq[: max(0, i - 1)] for a in wk}  # areas at least two weeks back
        review = [
            a
            for a in AREAS
            if a in visited and a not in focus and (area_evidence_mastery(learner, a) or 1.0) < 0.4
        ][:1]
        mock = next((m.isoformat() for m in mocks if start <= m <= end), None)
        weeks.append(
            {
                "n": i + 1,
                "start": start.isoformat(),
                "focus": [AREA_LABELS.get(a, a.title()) for a in focus],
                "review": [AREA_LABELS[a] for a in review],
                "problems": 6 if last else 12,
                "sessions": 2 if last else 4,
                "mock": mock,
                "exam": e.isoformat() if start <= e <= end else None,
            }
        )
    return {
        "exam": e.isoformat(),
        "days_left": (e - t).days,
        "format": "4 sessions × 90 min × 3 problems",
        "weeks": weeks,
    }
