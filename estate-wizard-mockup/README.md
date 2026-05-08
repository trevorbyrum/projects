# Estate Plan Wizard — Mockup

A single-file, no-build HTML prototype of a TurboTax-style guided wizard for
the estate-planning intake currently broken across four separate forms on
[simplewilltexas.com](https://simplewilltexas.com): **Family**, **Beneficiaries**,
**Fiduciaries**, and **Ancillary Documents**.

The goal is to demonstrate the *feel* of a unified, branching, plain-language
flow before committing engineering effort to building it for real.

---

## Why a wizard

The current site has four standalone forms totalling roughly 150 fields. Each
one is a wall of inputs that a non-lawyer has to interpret on their own.

A guided wizard:

- Maps to how the legal documents are actually assembled (one estate plan, not
  four disconnected intakes).
- Lets you skip irrelevant branches automatically. No spouse → no spouse
  fields. No minor children → no guardian section. Doesn't want a Living Will
  → no end-of-life questions.
- Surfaces plain-language explanations in context (per stirpes, community
  property, what an executor actually does) instead of expecting users to
  Google legal terms mid-form.
- Validates as the user goes — including cross-section conflict checks like
  "your only beneficiary is also your executor" — instead of bouncing them
  with a server error after submit.
- Saves automatically so users can leave and resume.

This was prototyped after evaluating chatbot and wizard approaches. Estate
planning is form-shaped, not conversation-shaped: the output is a structured
legal document, beneficiary lists with percentages don't translate well to
chat, and users need to see progress on a serious task. The wizard is the
primary flow, with a "Help / Explain this" affordance per step covering the
hand-holding a chatbot would otherwise provide.

---

## Run it

It's a single static file with no dependencies, no build step, no server.

```bash
open index.html        # macOS
# or
xdg-open index.html    # Linux
# or just double-click it
```

To view on an iPhone, the easiest path is to push this repo to GitHub and
either:

- Enable **GitHub Pages** on `main` and visit
  `https://<your-username>.github.io/<repo>/`, or
- Use **raw.githack.com** if the repo is public:
  `https://raw.githack.com/<user>/<repo>/main/index.html`

---

## Wizard flow

The full flow is up to 12 steps. Conditional steps appear or disappear based
on earlier answers.

```
1.  Welcome
2.  About you (contact info)
3.  Marital status + minor children?
4.  Spouse                           ← only if married
5.  Children & family
6.  Primary beneficiaries
7.  Distribution method (with custom % allocator)
8.  Specific gifts (optional)
9.  Executor + alternate
10. Guardian + alternate             ← only if hasMinorChildren
11. Healthcare & POA selection (4 docs, opt-in)
12. Agents (medical / financial)     ← only if a POA was chosen
13. Review (click-to-edit, conflict checks)
14. Submitted (mock)
```

### Skip logic that actually fires

- **Single / divorced / widowed** → spouse step disappears entirely
- **No minor children** → guardian step disappears
- **Both POAs unchecked** → agents step disappears
- **Custom %** distribution → reveals a per-beneficiary allocator with a
  running total that turns red until it sums to 100

### Plain-language help

Tap the **ⓘ Explain** links to open a contextual side drawer. Currently
covers:

- **Texas community property** (on the marital status step)
- **Per stirpes** (on the distribution step)
- **What an executor does** (on the fiduciary step)

These are the legal concepts users most often Google when filling out an
estate-planning form.

### Review screen

The penultimate step summarises everything, with:

- One **Edit** button per section that jumps back to that step
- Lightweight conflict detection (e.g. "your only beneficiary is also your
  executor — flag for attorney review")
- Custom-percentage validation (must sum to 100)

### Persistence

Everything autosaves to `localStorage` under the key
`swt-wizard-mockup-v1`. The pill in the top-right flashes "Saving…" → "Saved"
on every keystroke. Refresh the page and your answers persist. The final
"Submitted" step has a **Reset mockup** button that clears storage.

---

## What's real vs. what's mocked

**Real / production-shaped**

- Field names match the live SimpleWill app's existing yup schemas
  (`clientFirstName`, `spouseDateOfBirth`, `executorRelationship`,
  `needsMedicalPOA`, etc.) so the data model could plug straight into the
  current `/api/forms/*` endpoints.
- Branching logic uses the same flag fields the live forms already define
  (`hasSpouse`, `hasMinorChildren`, `needsTrustee`, `needs*POA`).
- Step decomposition reflects how a real wizard would slice the existing
  forms — no field has more than ~10 inputs per screen.

**Mocked**

- "Submit to attorney" just shows a toast; nothing is sent.
- Persistence is local-only. A real build needs a backend draft store +
  email magic-link resume.
- Help drawer covers three concepts as a sample. A real build would cover
  every legal term in the flow, written by the attorney.
- No auth, no payment, no PDF preview, no e-sign.
- No accessibility audit yet (focus management on step transitions, ARIA on
  the progress bar, etc. would all need work).

---

## File layout

```
.
├── index.html      # everything: HTML + CSS + JS in one file
└── README.md
```

The whole prototype is ~700 lines. CSS is plain (no Tailwind), JS is plain
DOM (no framework). This is intentional: the goal is to prove out the *flow*,
not the production stack. The real thing should be built in the existing
React + yup codebase the live site already uses.

---

## Findings from the existing site

Reverse-engineered from the production JS bundles on simplewilltexas.com:

| Form           | Chunk                          | Endpoint                 |
| -------------- | ------------------------------ | ------------------------ |
| Family         | `family-Be2W3u6e.js` (27 KB)   | `POST /api/forms/family` |
| Beneficiaries  | `beneficiaries-DQK9_h-c.js`    | `POST /api/forms/beneficiaries` |
| Fiduciaries    | `fiduciaries-D-EynamR.js`      | `POST /api/forms/fiduciaries` |
| Ancillary      | `ancillary-BrswUj_i.js`        | `POST /api/forms/ancillary` |

Stack: **Vite + React + yup**. No state management library, no form library
beyond yup; each form is a self-contained component. This is a good
foundation to build the wizard on — most of the validation work is already
done.

---

## What it would take to ship this for real

Roughly, in priority order:

1. Wizard shell component in the existing React app (step index, progress,
   Back/Next, Save & Exit, review screen).
2. Re-slice the existing four forms into ~12 wizard steps. Reuse the
   existing yup field schemas verbatim.
3. Cross-form skip logic on the same flag fields the existing forms already
   have.
4. Backend draft store + email-based resume link. The biggest single piece
   of new work.
5. Attorney-written help content for every legal term. Bigger lift than the
   engineering.
6. Conflict-detection rules (same person as executor + sole beneficiary,
   percentage totals, naming a minor as executor, etc.).
7. Accessibility pass.

Engineering side is mostly mechanical given the existing schema. The hard
parts are content (plain-language explanations) and legal logic
(conflict rules), both of which need the attorney's involvement, not a
developer's.
