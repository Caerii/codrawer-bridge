/-!
Fixture `odd_sum`: the learner's induction proof that 1 + 3 + ⋯ + (2n−1) = n², formalized step by
step in core Lean 4 (no Mathlib). Hand-written to mirror the steps in `odd_sum.transcript.json`;
check.py runs it when `lean` is installed.
-/

/-- The sum of the first `n` odd numbers. -/
def oddSum : Nat → Nat
  | 0 => 0
  | n + 1 => oddSum n + (2 * n + 1)

/-- Step 1 (base case): for n = 1 the sum is 1 = 1². -/
theorem step1_base : oddSum 1 = 1 * 1 := rfl

/-- Steps 2–5: assume the claim for k; add the next odd number 2k + 1; regroup as (k + 1)². -/
theorem odd_sum_sq (n : Nat) : oddSum n = n * n := by
  induction n with
  | zero => rfl
  | succ k ih =>
    -- step 3: the sum to k + 1 is the sum to k plus 2k + 1
    have h3 : oddSum (k + 1) = oddSum k + (2 * k + 1) := rfl
    -- step 4: by the induction hypothesis that is k² + 2k + 1
    have h4 : oddSum (k + 1) = k * k + (2 * k + 1) := by rw [h3, ih]
    -- step 5: k² + 2k + 1 = (k + 1)²
    have h5 : k * k + (2 * k + 1) = (k + 1) * (k + 1) := by
      simp only [Nat.add_mul, Nat.mul_add, Nat.mul_one, Nat.one_mul]; omega
    rw [h4, h5]
