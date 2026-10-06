"""
The task model's vocabulary: a graph of proof concepts and a catalog of misconceptions.

**The problem.** To tutor a proof the Primer has to say *what* a step uses ("this is the
contrapositive", "this needs p² even ⇒ p even") and *what is missing* ("you never assumed lowest
terms"). Both need names that stay stable across turns, across learners and across the model
calls that read the page, so that evidence from Tuesday's induction proof and Thursday's
pigeonhole problem lands on the same learner-model entries (learner.py). This module is that
vocabulary, written down once, in code, so tests can check it.

**What is here.**

- :data:`CONCEPTS`: about seventy concepts, from the logic every proof rests on (implication
  versus equivalence, quantifier order, contradiction, contrapositive, induction) up to the
  techniques a Putnam paper asks for (pigeonhole, invariants and monovariants, the extremal
  principle, modular arithmetic and orders, AM-GM and Cauchy-Schwarz, Vieta, eigenvalue and rank
  tricks, the mean value theorem, series tests, double counting and generating functions,
  linearity of expectation, functional equations, roots of unity). Each names its prerequisites;
  the prerequisite relation is a DAG (checked by :func:`check_graph` and the tests), so "the
  frontier" (concepts whose prerequisites are mastered but which are not) is well defined.
- :data:`MISCONCEPTIONS`: first-class entries for the ways proofs go wrong, in three kinds:
  ``misconception`` (a wrong belief: converse confusion, quantifier swap), ``missing_rigor`` (a
  true claim used without the proof it needs: "p² even ⇒ p even" asserted, the lowest-terms
  assumption skipped, a base case omitted) and ``exposition`` (the argument may be right but the
  reader cannot follow it: undefined variables, no conclusion stated). Putnam graders mark down
  all three (ADR 010, "Assessment"), so the Primer tracks all three.

**Facts it rests on.** The concept list follows the topic outline of the Putnam competition as
reflected in its archive (Kedlaya, Poonen, Vakil, *The William Lowell Putnam Mathematical
Competition 1985–2000*, MAA 2002, and the yearly solutions at kskedlaya.org/putnam-archive) and
the standard problem-solving texts (Zeitz, *The Art and Craft of Problem Solving*; Engel,
*Problem-Solving Strategies*). The misconception entries are the classic errors in the
proof-learning literature (Selden & Selden 1987, "Errors and misconceptions in college level
theorem proving"; Weber 2001, "Student difficulty in constructing proofs"; Dubinsky & Yiparaki
2000 on quantifier order) plus the gaps graders cite most.

Ids are snake_case and never reused: a renamed concept keeps its id, so learner files stay valid.
"""

from __future__ import annotations

# ruff: noqa: E501  (catalog prose and prompt text read better unwrapped)
from collections.abc import Iterable
from dataclasses import dataclass, field

# =============================================================================================
# Concepts
# =============================================================================================


@dataclass(frozen=True)
class Concept:
    """
    One node of the task model's concept graph.

    - ``id``: stable snake_case key (learner files store mastery under it).
    - ``label``: what the learner sees.
    - ``area``: one of :data:`AREAS` (groups the plan's weeks and the panel's bars).
    - ``prereqs``: ids of concepts this one builds on. The relation is acyclic.
    - ``level``: rough depth, 1 (first proofs) to 4 (hard Putnam technique); seeds the BKT prior
      (learner.py) and orders the plan.
    - ``blurb``: one sentence the Primer can say when the concept comes up.
    """

    id: str
    label: str
    area: str
    prereqs: tuple[str, ...] = ()
    level: int = 1
    blurb: str = ""


#: The areas, in the order a two-month plan visits them (practice.py).
AREAS: tuple[str, ...] = (
    "logic",
    "techniques",
    "number_theory",
    "inequalities",
    "polynomials",
    "combinatorics",
    "linear_algebra",
    "analysis",
    "probability",
    "functional_equations",
    "complex",
)

AREA_LABELS: dict[str, str] = {
    "logic": "Logic and proof",
    "techniques": "Problem-solving techniques",
    "number_theory": "Number theory",
    "inequalities": "Inequalities",
    "polynomials": "Polynomials",
    "combinatorics": "Combinatorics",
    "linear_algebra": "Linear algebra",
    "analysis": "Analysis and calculus",
    "probability": "Probability",
    "functional_equations": "Functional equations",
    "complex": "Complex numbers and geometry",
}


def _c(
    id: str, label: str, area: str, prereqs: Iterable[str] = (), level: int = 1, blurb: str = ""
) -> Concept:
    return Concept(id, label, area, tuple(prereqs), level, blurb)


_CONCEPT_LIST: list[Concept] = [
    # ── Logic and proof: what every write-up rests on ────────────────────────────────────────
    _c(
        "statements",
        "Statements and truth",
        "logic",
        (),
        1,
        "A proof is a chain of statements, each true for a stated reason.",
    ),
    _c(
        "implication",
        "Implication",
        "logic",
        ["statements"],
        1,
        "P ⇒ Q says nothing when P is false.",
    ),
    _c(
        "converse_inverse",
        "Converse and inverse",
        "logic",
        ["implication"],
        1,
        "Q ⇒ P (converse) and ¬P ⇒ ¬Q (inverse) do not follow from P ⇒ Q.",
    ),
    _c(
        "equivalence",
        "Implication versus equivalence",
        "logic",
        ["implication", "converse_inverse"],
        1,
        "P ⇔ Q needs both directions.",
    ),
    _c(
        "quantifiers",
        "Quantifiers",
        "logic",
        ["statements"],
        1,
        "∀ and ∃: what is being claimed, for which objects.",
    ),
    _c(
        "quantifier_order",
        "Quantifier order",
        "logic",
        ["quantifiers"],
        2,
        "∀x ∃y is not ∃y ∀x: the order is the claim.",
    ),
    _c(
        "negation",
        "Negating statements",
        "logic",
        ["quantifiers", "implication"],
        1,
        "¬(∀x P) is ∃x ¬P; ¬(P ⇒ Q) is P ∧ ¬Q.",
    ),
    _c(
        "direct_proof",
        "Direct proof",
        "logic",
        ["implication"],
        1,
        "Assume the hypothesis, derive the conclusion.",
    ),
    _c(
        "contrapositive",
        "Proof by contrapositive",
        "logic",
        ["implication", "negation"],
        1,
        "¬Q ⇒ ¬P proves P ⇒ Q.",
    ),
    _c(
        "contradiction",
        "Proof by contradiction",
        "logic",
        ["negation"],
        1,
        "Assume the negation of the goal and reach something false.",
    ),
    _c(
        "cases",
        "Proof by cases",
        "logic",
        ["direct_proof"],
        1,
        "Cover every case; say why the cases are exhaustive.",
    ),
    _c(
        "counterexample",
        "Counterexamples",
        "logic",
        ["quantifiers", "negation"],
        1,
        "One example refutes a ∀; no number of examples proves one.",
    ),
    _c(
        "existence_uniqueness",
        "Existence and uniqueness",
        "logic",
        ["quantifiers"],
        2,
        "Show one exists; show any two are equal.",
    ),
    _c(
        "wlog",
        "Without loss of generality",
        "logic",
        ["cases"],
        2,
        "Say which symmetry makes the reduction honest.",
    ),
    _c(
        "definitions",
        "Using definitions precisely",
        "logic",
        ["statements"],
        1,
        "Unpack the definition; that is usually the first step.",
    ),
    # ── Induction and the core techniques ────────────────────────────────────────────────────
    _c(
        "induction",
        "Mathematical induction",
        "techniques",
        ["implication", "quantifiers"],
        1,
        "Base case, and P(k) ⇒ P(k+1) using P(k).",
    ),
    _c(
        "strong_induction",
        "Strong induction",
        "techniques",
        ["induction"],
        2,
        "Assume all smaller cases, not just the previous one.",
    ),
    _c(
        "structural_induction",
        "Structural induction",
        "techniques",
        ["induction"],
        3,
        "Induct on how an object is built: trees, words, formulas.",
    ),
    _c(
        "well_ordering",
        "Well-ordering and infinite descent",
        "techniques",
        ["induction", "contradiction"],
        2,
        "A smallest counterexample cannot exist; descent cannot go on forever.",
    ),
    _c(
        "pigeonhole",
        "Pigeonhole principle",
        "techniques",
        ["counting_basics"],
        2,
        "n+1 objects in n boxes: some box holds two. Say what the boxes are.",
    ),
    _c(
        "invariants",
        "Invariants",
        "techniques",
        ["parity"],
        2,
        "Find a quantity no move changes; compare start and goal.",
    ),
    _c(
        "monovariants",
        "Monovariants",
        "techniques",
        ["invariants", "well_ordering"],
        3,
        "A quantity that only moves one way forces termination.",
    ),
    _c(
        "extremal_principle",
        "Extremal principle",
        "techniques",
        ["well_ordering"],
        3,
        "Look at the largest, smallest, first or last object.",
    ),
    _c(
        "coloring",
        "Coloring arguments",
        "techniques",
        ["parity", "invariants"],
        2,
        "Colour the board so each move covers a fixed colour pattern.",
    ),
    _c(
        "parity",
        "Parity",
        "techniques",
        ["definitions"],
        1,
        "Even and odd: n = 2k or n = 2k+1, and how they combine.",
    ),
    _c(
        "symmetry",
        "Symmetry and small cases",
        "techniques",
        ["statements"],
        1,
        "Try small cases, look for symmetry, conjecture before proving.",
    ),
    # ── Number theory ────────────────────────────────────────────────────────────────────────
    _c(
        "divisibility",
        "Divisibility",
        "number_theory",
        ["definitions"],
        1,
        "a | b means b = ka for an integer k.",
    ),
    _c(
        "primes",
        "Primes and factorization",
        "number_theory",
        ["divisibility"],
        1,
        "Every integer > 1 factors uniquely into primes.",
    ),
    _c(
        "euclid_lemma",
        "Euclid's lemma",
        "number_theory",
        ["primes", "gcd"],
        2,
        "p | ab ⇒ p | a or p | b, for p prime.",
    ),
    _c(
        "gcd",
        "GCD and Bézout",
        "number_theory",
        ["divisibility"],
        2,
        "gcd(a,b) = ax + by for some integers x, y.",
    ),
    _c(
        "rationality",
        "Rationals and lowest terms",
        "number_theory",
        ["gcd", "definitions"],
        1,
        "Every rational is p/q with gcd(p,q)=1 and q > 0; say so when you use it.",
    ),
    _c(
        "irrationality",
        "Irrationality proofs",
        "number_theory",
        ["rationality", "contradiction", "parity"],
        2,
        "Assume p/q in lowest terms; find a common factor.",
    ),
    _c(
        "square_parity",
        "p² even ⇒ p even",
        "number_theory",
        ["parity", "contrapositive"],
        1,
        "True, and it needs its own one-line proof (odd² is odd).",
    ),
    _c(
        "modular_arithmetic",
        "Modular arithmetic",
        "number_theory",
        ["divisibility"],
        2,
        "Work with remainders; congruences add and multiply.",
    ),
    _c(
        "fermat_euler",
        "Fermat and Euler theorems",
        "number_theory",
        ["modular_arithmetic", "gcd"],
        3,
        "a^φ(n) ≡ 1 (mod n) when gcd(a,n)=1.",
    ),
    _c(
        "orders",
        "Multiplicative order",
        "number_theory",
        ["fermat_euler"],
        3,
        "The least k with a^k ≡ 1 divides every exponent that works.",
    ),
    _c(
        "crt",
        "Chinese remainder theorem",
        "number_theory",
        ["modular_arithmetic", "gcd"],
        3,
        "Coprime moduli combine uniquely.",
    ),
    _c(
        "diophantine",
        "Diophantine equations",
        "number_theory",
        ["modular_arithmetic", "well_ordering"],
        3,
        "Reduce mod m, bound, or descend.",
    ),
    # ── Inequalities ─────────────────────────────────────────────────────────────────────────
    _c(
        "inequality_basics",
        "Manipulating inequalities",
        "inequalities",
        ["direct_proof"],
        1,
        "Multiplying by a negative flips the sign; squares are ≥ 0.",
    ),
    _c(
        "am_gm",
        "AM-GM",
        "inequalities",
        ["inequality_basics"],
        2,
        "The arithmetic mean is at least the geometric mean; equality iff all equal.",
    ),
    _c(
        "cauchy_schwarz",
        "Cauchy-Schwarz",
        "inequalities",
        ["inequality_basics"],
        3,
        "(Σaᵢbᵢ)² ≤ (Σaᵢ²)(Σbᵢ²).",
    ),
    _c(
        "jensen",
        "Jensen and convexity",
        "inequalities",
        ["inequality_basics", "derivatives"],
        3,
        "For convex f, f(mean) ≤ mean of f.",
    ),
    _c(
        "rearrangement",
        "Rearrangement inequality",
        "inequalities",
        ["inequality_basics"],
        3,
        "Similarly sorted sequences maximize the sum of products.",
    ),
    _c(
        "equality_cases",
        "Equality cases",
        "inequalities",
        ["am_gm"],
        2,
        "Say when equality holds; it checks the argument.",
    ),
    # ── Polynomials ──────────────────────────────────────────────────────────────────────────
    _c(
        "polynomial_roots",
        "Roots and the factor theorem",
        "polynomials",
        ["definitions"],
        2,
        "r is a root iff (x - r) divides p(x).",
    ),
    _c(
        "vieta",
        "Vieta's formulas",
        "polynomials",
        ["polynomial_roots"],
        2,
        "Coefficients are symmetric functions of the roots.",
    ),
    _c(
        "irreducibility",
        "Irreducibility",
        "polynomials",
        ["polynomial_roots", "primes"],
        3,
        "Eisenstein, reduction mod p, rational root test.",
    ),
    _c(
        "polynomial_interpolation",
        "Interpolation and degree",
        "polynomials",
        ["polynomial_roots"],
        3,
        "A degree-n polynomial is fixed by n+1 values.",
    ),
    # ── Combinatorics ────────────────────────────────────────────────────────────────────────
    _c(
        "counting_basics",
        "Counting basics",
        "combinatorics",
        ["statements"],
        1,
        "Sum and product rules; say what is being counted.",
    ),
    _c(
        "binomial",
        "Binomial coefficients",
        "combinatorics",
        ["counting_basics"],
        1,
        "C(n,k) counts k-subsets; Pascal's rule.",
    ),
    _c(
        "bijections",
        "Bijective proofs",
        "combinatorics",
        ["counting_basics", "definitions"],
        2,
        "Two sets have the same size if you can pair them off; prove it is a bijection.",
    ),
    _c(
        "double_counting",
        "Double counting",
        "combinatorics",
        ["counting_basics"],
        2,
        "Count one set two ways and equate.",
    ),
    _c(
        "inclusion_exclusion",
        "Inclusion-exclusion",
        "combinatorics",
        ["counting_basics"],
        2,
        "Add singles, subtract pairs, add triples…",
    ),
    _c(
        "recurrences",
        "Recurrences",
        "combinatorics",
        ["induction"],
        2,
        "Set up the recurrence, then solve or bound it.",
    ),
    _c(
        "generating_functions",
        "Generating functions",
        "combinatorics",
        ["recurrences", "binomial", "series"],
        3,
        "Encode a sequence as coefficients; algebra does the counting.",
    ),
    _c(
        "graph_basics",
        "Graphs",
        "combinatorics",
        ["counting_basics"],
        2,
        "Degrees, paths, trees; the handshake lemma.",
    ),
    # ── Linear algebra ───────────────────────────────────────────────────────────────────────
    _c(
        "matrices",
        "Matrices and linear maps",
        "linear_algebra",
        ["definitions"],
        2,
        "A matrix is a linear map in coordinates.",
    ),
    _c(
        "determinants",
        "Determinants",
        "linear_algebra",
        ["matrices"],
        2,
        "Multilinear, alternating; det(AB) = det A det B.",
    ),
    _c(
        "rank",
        "Rank and nullity",
        "linear_algebra",
        ["matrices"],
        3,
        "rank + nullity = n; rank(AB) ≤ min(rank A, rank B).",
    ),
    _c(
        "eigenvalues",
        "Eigenvalues",
        "linear_algebra",
        ["determinants"],
        3,
        "Roots of det(A - λI); trace and determinant from them.",
    ),
    _c(
        "determinant_parity",
        "Determinants mod p",
        "linear_algebra",
        ["determinants", "modular_arithmetic"],
        4,
        "Reduce a determinant mod 2 to show it is nonzero.",
    ),
    # ── Analysis and calculus ────────────────────────────────────────────────────────────────
    _c(
        "limits",
        "Limits (ε-δ)",
        "analysis",
        ["quantifier_order", "inequality_basics"],
        2,
        "For every ε there is a δ: quantifier order in action.",
    ),
    _c(
        "continuity",
        "Continuity and IVT",
        "analysis",
        ["limits"],
        2,
        "A continuous function on an interval takes every value in between.",
    ),
    _c(
        "derivatives",
        "Derivatives",
        "analysis",
        ["limits"],
        2,
        "The derivative as a limit; monotonicity from its sign.",
    ),
    _c(
        "mvt",
        "Mean value theorem",
        "analysis",
        ["derivatives", "continuity"],
        3,
        "f(b) - f(a) = f'(c)(b - a) for some c in between: name the hypotheses.",
    ),
    _c(
        "integrals",
        "Integrals",
        "analysis",
        ["derivatives"],
        2,
        "The fundamental theorem; substitution; symmetry of the interval.",
    ),
    _c(
        "series",
        "Series convergence",
        "analysis",
        ["limits"],
        3,
        "Comparison, ratio, integral test; absolute versus conditional.",
    ),
    _c(
        "sequences",
        "Sequences and monotone convergence",
        "analysis",
        ["limits"],
        2,
        "Bounded monotone sequences converge.",
    ),
    # ── Probability ──────────────────────────────────────────────────────────────────────────
    _c(
        "probability_basics",
        "Probability basics",
        "probability",
        ["counting_basics"],
        2,
        "Equally likely outcomes; conditional probability.",
    ),
    _c(
        "expectation",
        "Linearity of expectation",
        "probability",
        ["probability_basics"],
        2,
        "E[X + Y] = E[X] + E[Y], independent or not.",
    ),
    _c(
        "geometric_probability",
        "Geometric probability",
        "probability",
        ["probability_basics", "integrals"],
        3,
        "Probability as a ratio of areas or volumes.",
    ),
    # ── Functional equations ─────────────────────────────────────────────────────────────────
    _c(
        "functional_equations",
        "Functional equations",
        "functional_equations",
        ["definitions", "cases"],
        3,
        "Substitute special values; prove the candidate works and is the only one.",
    ),
    _c(
        "cauchy_equation",
        "Cauchy's equation",
        "functional_equations",
        ["functional_equations", "induction", "rationality"],
        3,
        "f(x+y) = f(x) + f(y) gives f(q) = qf(1) on the rationals.",
    ),
    # ── Complex numbers and geometry ─────────────────────────────────────────────────────────
    _c(
        "complex_numbers",
        "Complex numbers",
        "complex",
        ["definitions"],
        2,
        "a + bi; modulus, argument, conjugate.",
    ),
    _c(
        "roots_of_unity",
        "Roots of unity",
        "complex",
        ["complex_numbers", "polynomial_roots"],
        3,
        "The n-th roots of 1 sum to 0 for n > 1; filter coefficients with them.",
    ),
    _c(
        "complex_geometry",
        "Complex numbers in geometry",
        "complex",
        ["complex_numbers"],
        3,
        "Rotations are multiplications; distances are moduli.",
    ),
]

#: Every concept by id.
CONCEPTS: dict[str, Concept] = {c.id: c for c in _CONCEPT_LIST}


# =============================================================================================
# Misconceptions, missing rigor, exposition
# =============================================================================================


@dataclass(frozen=True)
class Misconception:
    """
    A first-class way a proof goes wrong.

    - ``kind``: ``misconception`` (a wrong belief), ``missing_rigor`` (a true claim used without
      its proof, or a hypothesis never stated) or ``exposition`` (the reader cannot follow).
    - ``concepts``: the concepts this entry is evidence *against* when it is seen (learner.py
      lowers their mastery) and the ones a remedy should practise.
    - ``severity``: how a Putnam grader would treat it in an otherwise complete solution:
      ``fatal`` (no better than partial credit), ``major`` (loses several points), ``minor``
      (loses a point or two).
    - ``probe``: a Socratic question that makes the learner find it themselves (policy.py);
      ``{step}`` is replaced by the step number.
    - ``hints``: the hint ladder for it, least to most revealing. The last rung still is not
      the corrected proof: the Primer never writes the solution unasked (ADR 010).
    - ``signals``: lowercase phrases whose presence or absence in a transcription suggests it,
      used only by the offline detector (assess.py); a live model call names entries directly.
    """

    id: str
    label: str
    kind: str
    concepts: tuple[str, ...]
    severity: str
    probe: str
    hints: tuple[str, ...]
    signals: tuple[str, ...] = field(default=())


def _m(
    id: str,
    label: str,
    kind: str,
    concepts: Iterable[str],
    severity: str,
    probe: str,
    hints: Iterable[str],
    signals: Iterable[str] = (),
) -> Misconception:
    return Misconception(
        id, label, kind, tuple(concepts), severity, probe, tuple(hints), tuple(signals)
    )


_MISCONCEPTION_LIST: list[Misconception] = [
    # ── Wrong beliefs ────────────────────────────────────────────────────────────────────────
    _m(
        "assumes_conclusion",
        "Assumes what is to be proved",
        "misconception",
        ["direct_proof", "implication"],
        "fatal",
        "In step {step}, which statement are you using that is the thing you set out to prove?",
        [
            "Write the goal at the top and check each step's reasons against it.",
            "A step may use the hypotheses and earlier steps, never the goal itself.",
            "Find the first step whose reason is the goal; that is where the argument must change.",
        ],
    ),
    _m(
        "converse_confusion",
        "Uses the converse or inverse of an implication",
        "misconception",
        ["converse_inverse", "implication"],
        "fatal",
        "Step {step} uses an implication. Which direction did you prove, and which direction does step {step} need?",
        [
            "Write the implication you know as 'if … then …'.",
            "Is the step using 'if A then B' or 'if B then A'?",
            "If the direction you need is the converse, it needs its own proof or a counterexample shows it fails.",
        ],
    ),
    _m(
        "equivalence_one_way",
        "Proves only one direction of an 'if and only if'",
        "misconception",
        ["equivalence"],
        "major",
        "The statement is an 'if and only if'. Which of the two directions does your proof cover?",
        [
            "List the two implications an 'iff' contains.",
            "Prove the missing direction separately, or argue each step is reversible.",
        ],
    ),
    _m(
        "quantifier_swap",
        "Swaps the order of quantifiers",
        "misconception",
        ["quantifier_order"],
        "fatal",
        "In step {step}, does your choice depend on the variable that came before it, or is it one choice for all of them?",
        [
            "Write the claim with ∀ and ∃ in order.",
            "∀x ∃y lets y depend on x; ∃y ∀x needs one y for every x.",
            "Check whether your y was chosen after x was fixed.",
        ],
    ),
    _m(
        "example_as_proof",
        "Checks examples instead of proving the general case",
        "misconception",
        ["quantifiers", "counterexample"],
        "fatal",
        "Your examples all work. What guarantees the next one will?",
        [
            "Examples suggest; they do not prove a statement about all n.",
            "Name an arbitrary n and argue for it.",
        ],
        ["for example", "e.g.", "check n=1", "n = 1, 2, 3"],
    ),
    _m(
        "negation_error",
        "Negates a statement incorrectly",
        "misconception",
        ["negation"],
        "major",
        "Step {step} assumes the opposite of the goal. Write the goal and its negation one under the other: do they match?",
        ["¬(∀x P(x)) is ∃x ¬P(x).", "¬(P ⇒ Q) is P ∧ ¬Q, not ¬P ⇒ ¬Q."],
    ),
    _m(
        "division_by_zero",
        "Divides by something that may be zero",
        "misconception",
        ["inequality_basics", "cases"],
        "major",
        "In step {step} you divide. Could that quantity be zero?",
        ["Before dividing, say why the divisor is nonzero, or split off the zero case."],
    ),
    _m(
        "inequality_sign_flip",
        "Multiplies an inequality by a quantity of unknown sign",
        "misconception",
        ["inequality_basics"],
        "major",
        "In step {step}, is the quantity you multiplied by positive?",
        [
            "Multiplying by a negative number reverses the inequality.",
            "Split into cases on the sign, or rearrange to avoid it.",
        ],
    ),
    # ── Missing rigor ────────────────────────────────────────────────────────────────────────
    _m(
        "sqrt2_no_lowest_terms",
        "Never assumes p/q is in lowest terms",
        "missing_rigor",
        ["rationality", "irrationality"],
        "fatal",
        "You end with p and q both even. Why is that a contradiction? What did you assume about p and q at the start?",
        [
            "Both even is only a contradiction if something forbids a common factor.",
            "Every rational number can be written as p/q with gcd(p, q) = 1. Did you say so?",
            "Add the assumption at the start, where p and q are introduced, and the last step becomes the contradiction.",
        ],
        ["lowest terms", "gcd", "coprime", "no common factor", "simplest form", "reduced"],
    ),
    _m(
        "square_parity_unproved",
        "Uses 'p² even ⇒ p even' without proof",
        "missing_rigor",
        ["square_parity", "contrapositive"],
        "minor",
        "Step {step} says p² even implies p even. Can you prove that in one line?",
        ["Try the contrapositive: if p is odd, what is p²?", "(2k+1)² = 2(2k²+2k) + 1."],
    ),
    _m(
        "induction_no_hypothesis",
        "Induction step does not use the induction hypothesis",
        "missing_rigor",
        ["induction"],
        "fatal",
        "Where in your step from k to k+1 do you use the statement for k?",
        [
            "The inductive step must assume P(k) and derive P(k+1) from it.",
            "Write P(k) out in full, then write P(k+1), and find P(k) inside P(k+1).",
        ],
    ),
    _m(
        "induction_no_base",
        "Omits or mis-states the base case",
        "missing_rigor",
        ["induction"],
        "major",
        "What happens at the very first value of n?",
        ["An inductive step with no base case proves nothing.", "Check P(1) (or P(0)) explicitly."],
    ),
    _m(
        "induction_wrong_target",
        "Inductive step proves the wrong statement",
        "missing_rigor",
        ["induction"],
        "major",
        "Write P(k+1) exactly. Is that what step {step} shows?",
        ["Substitute k+1 for n everywhere in the statement before you start the step."],
    ),
    _m(
        "pigeonhole_boxes_unclear",
        "Pigeonhole without saying what the boxes are",
        "missing_rigor",
        ["pigeonhole"],
        "major",
        "What are your pigeons and what are your boxes, and how many of each?",
        [
            "Name the boxes so that two objects in one box gives what you want.",
            "Count: more pigeons than boxes?",
        ],
    ),
    _m(
        "cases_not_exhaustive",
        "Cases do not cover every possibility",
        "missing_rigor",
        ["cases"],
        "major",
        "Your cases are listed in step {step}. Is there an input that falls in none of them?",
        ["State why the cases are exhaustive (for example: every integer is even or odd)."],
    ),
    _m(
        "theorem_hypotheses_unchecked",
        "Applies a theorem without checking its hypotheses",
        "missing_rigor",
        ["mvt", "continuity", "definitions"],
        "major",
        "Which theorem does step {step} use, and what does it need to be true first?",
        [
            "State the theorem's hypotheses (continuity on [a, b], differentiability on (a, b), …) and check each."
        ],
    ),
    _m(
        "equality_case_missing",
        "States an inequality's bound without its equality case",
        "missing_rigor",
        ["equality_cases"],
        "minor",
        "When is your bound attained? Does that case actually occur?",
        ["A claimed maximum or minimum needs an example that attains it."],
    ),
    _m(
        "limit_interchange",
        "Swaps a limit with a sum or integral without justification",
        "missing_rigor",
        ["series", "limits"],
        "major",
        "Step {step} moves a limit inside a sum. What allows that?",
        ["Uniform or dominated convergence, or a finite sum, justifies it; say which."],
    ),
    _m(
        "termination_unproved",
        "Claims a process stops without a monovariant",
        "missing_rigor",
        ["monovariants"],
        "major",
        "Why can't the process go on forever?",
        ["Find a nonnegative integer quantity that strictly decreases with every move."],
    ),
    _m(
        "bijection_unverified",
        "Claims a bijection without proving it is one",
        "missing_rigor",
        ["bijections"],
        "major",
        "Your map is defined in step {step}. Why is it one-to-one, and why is it onto?",
        ["Give the inverse map, or prove injective and surjective separately."],
    ),
    _m(
        "functional_eq_no_verification",
        "Finds a candidate function but never checks it",
        "missing_rigor",
        ["functional_equations"],
        "major",
        "You found f. Does it actually satisfy the equation, and is it the only one?",
        ["Substitute the candidate back into the equation.", "Uniqueness needs its own argument."],
    ),
    _m(
        "wlog_unjustified",
        "'Without loss of generality' with no stated symmetry",
        "missing_rigor",
        ["wlog"],
        "minor",
        "Which symmetry of the problem makes your 'without loss of generality' honest?",
        ["Say what swapping or rescaling leaves the problem unchanged."],
    ),
    # ── Exposition ───────────────────────────────────────────────────────────────────────────
    _m(
        "undefined_variable",
        "Uses a variable that was never introduced",
        "exposition",
        ["definitions"],
        "minor",
        "In step {step}, where does that letter come from?",
        ["Introduce every variable: 'let k be an integer with p = 2k'."],
    ),
    _m(
        "no_conclusion",
        "Never states what was proved",
        "exposition",
        ["statements"],
        "minor",
        "What is the last sentence a reader should see?",
        [
            "End by restating the claim as proved (and, in a contradiction proof, what the contradiction was)."
        ],
    ),
    _m(
        "unjustified_step",
        "A step with no reason a reader could check",
        "exposition",
        ["statements"],
        "minor",
        "Why does step {step} follow from what came before?",
        ["Give each nontrivial step its reason: a definition, a lemma, or an earlier step."],
    ),
]

#: Every misconception entry by id.
MISCONCEPTIONS: dict[str, Misconception] = {m.id: m for m in _MISCONCEPTION_LIST}

MISCONCEPTION_KINDS = ("misconception", "missing_rigor", "exposition")
SEVERITIES = ("fatal", "major", "minor")


# =============================================================================================
# Queries and integrity
# =============================================================================================


def prereq_closure(concept_id: str) -> set[str]:
    """Every concept ``concept_id`` depends on, transitively (not including itself)."""
    seen: set[str] = set()
    stack = list(CONCEPTS[concept_id].prereqs)
    while stack:
        c = stack.pop()
        if c not in seen:
            seen.add(c)
            stack.extend(CONCEPTS[c].prereqs)
    return seen


def topological_order() -> list[str]:
    """Concept ids with every prerequisite before the concepts that use it (Kahn's algorithm)."""
    indeg = {cid: len(c.prereqs) for cid, c in CONCEPTS.items()}
    users: dict[str, list[str]] = {cid: [] for cid in CONCEPTS}
    for cid, c in CONCEPTS.items():
        for p in c.prereqs:
            users[p].append(cid)
    ready = sorted(cid for cid, d in indeg.items() if d == 0)
    out: list[str] = []
    while ready:
        cid = ready.pop(0)
        out.append(cid)
        for u in sorted(users[cid]):
            indeg[u] -= 1
            if indeg[u] == 0:
                ready.append(u)
    if len(out) != len(CONCEPTS):
        raise ValueError("concept graph has a cycle")
    return out


def check_graph() -> list[str]:
    """
    Integrity problems in the concept graph and misconception catalog, as messages (empty when
    sound): unknown prerequisite or concept ids, self-loops, cycles, unknown areas, kinds or
    severities, probes without a question, and hint ladders shorter than one rung.
    """
    problems: list[str] = []
    for cid, c in CONCEPTS.items():
        if c.area not in AREAS:
            problems.append(f"{cid}: unknown area {c.area}")
        if not 1 <= c.level <= 4:
            problems.append(f"{cid}: level {c.level} outside 1..4")
        for p in c.prereqs:
            if p == cid:
                problems.append(f"{cid}: is its own prerequisite")
            elif p not in CONCEPTS:
                problems.append(f"{cid}: unknown prerequisite {p}")
    if not problems:
        try:
            topological_order()
        except ValueError as e:
            problems.append(str(e))
    for mid, m in MISCONCEPTIONS.items():
        if m.kind not in MISCONCEPTION_KINDS:
            problems.append(f"{mid}: unknown kind {m.kind}")
        if m.severity not in SEVERITIES:
            problems.append(f"{mid}: unknown severity {m.severity}")
        if not m.concepts:
            problems.append(f"{mid}: names no concept")
        for c in m.concepts:
            if c not in CONCEPTS:
                problems.append(f"{mid}: unknown concept {c}")
        if "?" not in m.probe:
            problems.append(f"{mid}: probe is not a question")
        if not m.hints:
            problems.append(f"{mid}: empty hint ladder")
    return problems
