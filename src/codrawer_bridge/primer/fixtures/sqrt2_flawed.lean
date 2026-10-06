/-!
Fixture `sqrt2_flawed`: the learner's flawed proof that √2 is irrational, formalized step by step
in core Lean 4 (no Mathlib), as written: p/q is never assumed to be in lowest terms, so the last
step ("p and q are both even, contradiction") has nothing to contradict. Lean rejects that step;
check.py reports the failure and the step it belongs to. Hand-written to mirror
`sqrt2_flawed.transcript.json`.
-/

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
    -- step 1: suppose √2 = p/q (no lowest-terms assumption was written)
    (_hq : 0 < q)
    -- step 2: squaring, p² = 2q²
    (h2 : p * p = 2 * (q * q)) : False := by
  -- step 3: p² = 2q² so p² is even, hence p is even
  have h3 : 2 ∣ p := two_dvd_of_two_dvd_sq p ⟨q * q, h2⟩
  -- step 4: p = 2k, so 4k² = 2q², q² = 2k²
  rcases h3 with ⟨k, hk⟩
  have h4 : q * q = 2 * (k * k) := by
    subst hk; grind
  -- step 5: so q is even
  have h5 : 2 ∣ q := two_dvd_of_two_dvd_sq q ⟨k * k, h4⟩
  -- step 6: p and q are both even: "contradiction". Nothing assumed forbids it.
  have h6 : False := by
    rcases h5 with ⟨j, hj⟩
    omega
  exact h6
