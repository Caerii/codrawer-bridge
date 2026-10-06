/-!
Fixture `sqrt2_correct`: the learner's proof that √2 is irrational, formalized step by step in
core Lean 4 (no Mathlib). "√2 = p/q in lowest terms" becomes natural numbers p, q with q > 0,
gcd p q = 1 and p² = 2q²; each `have` is one written step (`sqrt2_correct.transcript.json`).
Hand-written to mirror the learner's steps; check.py runs it when `lean` is installed.
-/

/-- The fact behind step 3: if p² is even then p is even (an odd square is odd). -/
theorem two_dvd_of_two_dvd_sq (p : Nat) (h : 2 ∣ p * p) : 2 ∣ p := by
  rcases Nat.mod_two_eq_zero_or_one p with h0 | h1
  · exact Nat.dvd_of_mod_eq_zero h0
  · exfalso
    have hp : p = 2 * (p / 2) + 1 := by omega
    have hsq : p * p = 4 * ((p / 2) * (p / 2)) + 4 * (p / 2) + 1 := by
      rw [hp]; grind
    rcases h with ⟨c, hc⟩
    omega

theorem sqrt2_irrational (p q : Nat)
    -- step 1: suppose √2 = p/q with p/q in lowest terms
    (_hq : 0 < q) (hlowest : Nat.gcd p q = 1)
    -- step 2: squaring, p² = 2q²
    (h2 : p * p = 2 * (q * q)) : False := by
  -- step 3: p² is even, so p is even
  have h3 : 2 ∣ p := two_dvd_of_two_dvd_sq p ⟨q * q, h2⟩
  -- step 4: write p = 2k; then 4k² = 2q², so q² = 2k²
  rcases h3 with ⟨k, hk⟩
  have h4 : q * q = 2 * (k * k) := by
    subst hk; grind
  -- step 5: q² is even, so q is even
  have h5 : 2 ∣ q := two_dvd_of_two_dvd_sq q ⟨k * k, h4⟩
  -- step 6: 2 divides both p and q, contradicting lowest terms
  have h6 : 2 ∣ Nat.gcd p q := Nat.dvd_gcd ⟨k, hk⟩ h5
  rw [hlowest] at h6
  omega
