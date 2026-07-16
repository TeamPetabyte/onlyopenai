# PipekAI Trainer Guide

*How to train the AI by testing and judging its answers — 10-minute read, for SAP/ABAP senior developers.*
*(ภาษาไทย: [trainer-guide.th.md](trainer-guide.th.md))*

> **Why your judgements matter:** every answer you grade becomes part of the
> **golden dataset**. The AI doesn't magically learn on its own — your verdicts
> and corrected answers are what we use to tune the prompts, measure accuracy,
> and (later) teach the AI by example. Ten minutes of grading a week compounds
> into a measurably smarter assistant.

---

## The training loop at a glance

```
🧪 Prompt Lab                                 📊 Evals
─────────────────────────────────────        ─────────────────────────────
1. Pick a skill + model                       5. Hit "Run Eval" any time
2. Paste code / attach a Z-program    ──►        → the AI re-answers every
3. Run → read the AI's answer                     ⭐ exam case and an AI
4. Judge it (✅/⚠️/❌ + corrected answer)          judge scores it against
   → good cases: click ⭐ "Add to exam set"       YOUR reference answers
                                              6. Score % tells us if a new
                                                 prompt/model got better
```

---

## Step by step: testing in the Prompt Lab

**Login** at the usual URL with your trainer account → you land on the admin
page → open **Prompt Lab** in the sidebar.

### 1. Choose what to test
| Control | What it does |
|---|---|
| **Skill under test** | Which system prompt the question is sent to (e.g. *Obsolete Statement Check*) |
| **Model** | Which AI model answers. **Terra** = everyday default. **Luna** = cheapest (quick smoke tests). **Sol** = strongest (hard cases) |
| **Reasoning effort** | How long the model thinks. **medium** is the default; raise to **high** for complex migration questions |

Click **📄 System prompt under test** to expand and read the exact prompt
being tested — the question you type is answered *by this prompt*.

### 2. Enter the question
- Type or paste ABAP code / a question into the **Question** box, **or**
- Click **📎 Attach files** and pick one or more Z-program source files
  (`.abap`, `.txt`, …, max 1 MB per file). The file content is appended into
  the question box with a `* ===== File: ... =====` header — you can edit or
  trim it before running.
- The character counter under the box shows how big your question is
  (bigger = more tokens = more cost).

### 3. Run
Click **▶ Run**. The answer appears in the right pane with a token count.
Each run costs real OpenAI tokens (typically a few baht) but **never touches
any customer project pool** — the Lab is a sandbox.

### 4. Judge the answer — the most important step
Below the answer, the **Verdict** bar appears:

| Verdict | When to use |
|---|---|
| ✅ **Correct** | Technically right and complete. Nothing important missing. |
| ⚠️ **Partially correct** | Right direction but incomplete or imprecise — **write what's missing in the Corrected answer box** |
| ❌ **Incorrect** | Wrong, misleading, or misses the real issue — **write the right answer in the Corrected answer box** |

Also fill in:
- **Corrected answer** *(shown for ⚠️/❌)* — the answer as it *should* have
  been. Write it the way you'd want a junior to receive it. This becomes the
  reference the AI is graded against, so precision here matters most.
- **Category** *(optional but valuable)* — a short tag like `FI`, `MM`, `SD`,
  `syntax`, `S4-migration`. Reports break down scores by these tags, showing
  exactly where the AI is weak.
- **Note** *(optional)* — anything worth remembering about this case.

Click **💾 Save verdict**. Done — the case is stored.

> **Tip — judge in batches:** you don't have to grade right after each run.
> Every run is saved to **📋 Test history** at the bottom of the page. Filter
> by *⏳ Not judged*, open each case, and grade them in one sitting.
> You can also re-open any judged case and change the verdict.

### 5. Promote good cases to the exam set (⭐)
Open a judged case in the history and click **☆ Add to exam set**.

- Only promote cases that are **worth re-testing forever**: real-world code,
  a clear correct reference, representative of daily work.
- Promotion requires a reference answer: verdict **✅ Correct** (the AI's own
  answer is the reference) or a **Corrected answer** you wrote.
- Skip duplicates and throwaway experiments — exam quality beats quantity.

**Target: ~30 promoted cases per skill** across categories. That's when the
scores start being statistically meaningful.

---

## Running an exam: the Evals page

Open **Evals** in the sidebar.

1. Pick the **skill** and the **model/effort** you want to examine.
   The header shows how many ⭐ exam cases are ready.
2. Click **▶ Run Eval**. A progress bar tracks the run (about 5–20 s per
   case). One run at a time; you can stop it mid-way.
3. Read the report:
   - **Latest score** — % of cases passed, with ⬆/⬇ vs the previous run and a
     trend line across runs.
   - **Category bars** — pass rate per category tag (this is where your
     category labels pay off: "*strong on syntax, weak on SD pricing*").
   - **Case list** — every case with the judge's one-line reason; click a case
     to see *question / golden reference / this run's answer* side by side.

**When to run:** after a skill prompt is edited, when trying a different
model/effort, or periodically as the exam set grows. A run over 30 cases
costs roughly ฿30–60 in OpenAI tokens (no customer pool impact).

**How to read a drop:** if the score falls after a prompt change, open the
failed cases, read the judge's reasons, fix the prompt, run again. Never ship
a prompt change that lowers the score.

---

## Ground rules

1. **Every test should end with a verdict.** An unjudged answer teaches us
   nothing — if you ran it, grade it (right away or later from the history).
2. **Corrected answers are gold.** Write them complete and precise — they are
   the standard everything gets measured against.
3. **Don't game the exam.** Judge what the AI actually said, not what you
   wish it said. An honest 60% we can fix; a flattered 95% we can't.
4. **Real code beats invented examples.** Actual Z-programs from projects
   (especially ECC6 → S/4HANA candidates) make the best cases.

## FAQ

**Does testing cost the company money?** Each run costs OpenAI tokens
(typically < ฿2 with Terra). It never deducts from customer project pools.

**Can I change a verdict later?** Yes — open the case in Test history and
save a new verdict. The latest one wins.

**Can I edit the skill prompts?** Yes — the **Skill Prompts** page (trainer
only). After editing, run an Eval to confirm the score didn't drop.

**Who can see/do all this?** Only **trainer** accounts. Admin accounts manage
users and billing and cannot touch training data at all.
