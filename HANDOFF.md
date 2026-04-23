# Job Hunt SaaS — Handoff Document

> **For the next Claude:** Read this top-to-bottom before responding to Tom's first message. This file is the single source of truth for what we're building, what's done, what's pending, and how Tom expects you to work. Tom's broader life/business context lives in `C:\Users\tomlu\OneDrive\Desktop\Money\TOM_BRAIN.md` — read that too on first boot.
>
> **Last updated:** 2026-04-23

---

## 1. Who Tom is (short version — full context in TOM_BRAIN.md)

- Tom Hall, 24, UK. Supply chain analyst at Grain & Frame.
- Building this Job Hunt SaaS as a productisation of his own job-search workflow.
- Wants out of his current role. Urgency is real.
- Communicates terse and blunt. Push back when needed. Don't over-narrate.
- Email on the new account may differ — current email is tomluke101@gmail.com.

## 2. What we're building

**Job Hunt SaaS / job-hunt-dashboard** — a tool that helps job seekers track applications and generate high-quality, personalised cover letters using their CV, profile, writing samples, and the job description.

- **Live URL:** https://job-hunt-dashboard-two.vercel.app
- **Repo:** https://github.com/tomluke101/job-hunt-dashboard
- **Local path:** `C:\Users\tomlu\OneDrive\Desktop\Money\Job hunt SaaS\job-hunt-dashboard`

## 3. Stack

- Next.js **16** with **Turbopack** (App Router). NOT the Next.js you know from training data — read `node_modules/next/dist/docs/` if uncertain. Heed `AGENTS.md`.
- React 19, TypeScript
- Tailwind v4
- Auth: **Clerk v7** (`@clerk/nextjs`)
- DB: **Supabase** (`@supabase/ssr` + service-role client in `lib/supabase-server.ts`)
- AI providers: OpenAI, Anthropic, Google Gemini, Mistral, Perplexity (for company research). Routed via `lib/ai-router.ts`. Users bring their own API keys (stored encrypted in `api_keys` table).
- Hosting: **Vercel** (production). Deploy via `npx vercel@latest deploy --prod --yes`.
- Icons: `lucide-react`

## 4. Current app surface (what exists and works)

```
app/
  _components/        Shared layout (PageHeader, sidebar nav)
  actions/            Server actions ("use server")
                      - applications.ts  (CRUD + bulk for tracker)
                      - cover-letters.ts (generate, refine, save, list)
                      - profile.ts       (profile, CVs, skills, writing samples, prefs)
                      - api-keys.ts      (per-user provider keys)
                      - preferences.ts   (task prefs)
  alerts/             Stub (NOT BUILT YET)
  contacts/           Stub (NOT BUILT YET)
  cover-letter/       Cover letter generator page — JD input, generate, refine, export Word/PDF, save, link to tracker
  cv/                 CV upload & management
  profile/            My Profile page — bio, CV(s), skills, writing samples, cover letter prefs (sign-off, name, header, etc.)
  roles/              Role browser (NOT BUILT YET — placeholder)
  settings/           User settings (API keys, etc.)
  tracker/            Application tracker — table view, CSV import, bulk actions, JD modal, cover letter view + paste-manual modal
  sign-in/, sign-up/  Clerk pages
```

Supabase schema lives in `supabase-schema.sql`, `supabase-profile-schema.sql`, `supabase-task-preferences.sql`.

## 5. Where we are RIGHT NOW (latest session, 2026-04-23)

Just deployed (commit `dd57a84`): removed the raw Supabase error message from the cover letter "Add" modal footer so customers never see it.

**Recent thread of work:**
1. Fixed sign-off rendering ("Kind regards, Thomas Hall" was on one line — now uses `whitespace-pre-line` + server-side `fixSignOff` regex).
2. Hardened cover letter prompt against editorialising / paraphrasing JD back at the reader / hollow "why this company" paragraphs. See `app/actions/cover-letters.ts` → `buildSystemPrompt`.
3. Added ability to view saved cover letters from the tracker (violet CL pill when a letter exists).
4. Added ability to PASTE a cover letter against a tracker entry (for letters used outside the tool or generated in manual mode).
5. Fixed the save bug — was throwing across the server-action boundary which surfaced as the masked "Server Components render" error in production. Refactored to return `{id?, error?}` pattern (`saveManualCoverLetter` in `app/actions/cover-letters.ts`).
6. Hit a Supabase schema gotcha: `cover_letters` table has no `provider` column. Removed it from the insert. **If we want to track which model wrote each letter, run:** `alter table cover_letters add column provider text;` in Supabase, then restore the `provider` field in `saveCoverLetter` and `saveManualCoverLetter`.
7. Removed the red error footer entirely from `AddCoverLetterModal` — errors now log to console only.

## 6. Pending build queue (what's next)

Roughly in priority order:

1. **Application email writer** (~45 min build) — generate the email body that goes with the application, same profile/JD context as cover letter.
2. **Interview prep section** — new nav section. Likely: prep notes per application, AI-generated likely questions from the JD, STAR-format answer drafts using profile/CV.
3. **UI / branding pass** at the end — once features feel right, polish look and feel as a single sweep.
4. **Onboarding flow** — first-run experience: connect Clerk, upload CV, set sign-off, paste a writing sample, generate first letter.
5. **Pricing page** — productisation step. Stripe or LemonSqueezy TBD.
6. **CV tailoring** — generate a tailored CV per JD (similar to cover letter pipeline).
7. **Alerts** — page exists as a stub, nothing built. Likely role alerts based on saved searches.
8. **Contacts** — page exists as a stub, nothing built. Likely networking contacts per company/application.

## 7. How Tom expects you to work (load-bearing — don't violate)

These are derived from explicit feedback Tom has given. Treat them as hard rules.

### Cover letter quality (he reviews every letter critically)
- **Sign-off must be on its own line.** Server-side `fixSignOff` regex + `whitespace-pre-line` on the rendered paragraphs. Never regress this.
- **No em dashes.** `sanitiseLetter` strips them. Prompt also bans them.
- **No editorialising / paraphrasing the JD back at the reader.** Banned patterns are encoded in `buildSystemPrompt`. Examples Tom flagged: "sits at the point where", "is work I understand in practice", "I've carried that [X] into everything since", describing what a department or role is for.
- **WHY THIS COMPANY paragraph:** if nothing genuine and specific can be said, write a third strong experience/achievement paragraph instead. A hollow why-this-company paragraph is worse than no why-this-company paragraph at all.
- Tom's view: *"I do not think that anyone talks like this in real life and I do not think it helps people to get a job."* — generic AI cover letter voice = failure.

### Customer-facing surface
- **Never leak raw Supabase / API errors to customers.** Log to `console.error` with a `[functionName]` prefix; either swallow on the UI or show a vetted generic message. The `AddCoverLetterModal` is the reference pattern.
- Any new save / mutate flow on a server action: return `{...; error?: string}` rather than throwing. Throws cross the RSC boundary as opaque "Server Components render" errors in production.

### General build style
- Don't add features, refactors, or abstractions beyond what was asked. Bug fixes don't need surrounding cleanup.
- Don't write comments unless the WHY is non-obvious. Code should explain WHAT.
- Type-check with `npx tsc --noEmit` before committing.
- Commit with a message that explains the WHY (one line is fine). No Claude attribution unless asked.
- After committing, **deploy to production**: `cd` into the project and run `npx vercel@latest deploy --prod --yes`. Tom expects features to land in prod immediately.
- If Tom asks "is X working" or shows a screenshot of an error, diagnose by checking the actual file/state — don't guess.

### Communication
- Short and direct. No headers and bullet sections for simple answers.
- One-sentence end-of-turn summary: what changed and what's next.
- Don't recap what you just did when the diff is visible.
- Push back if Tom is asking for something risky or suboptimal — explain why in one sentence, then defer to his decision.

## 8. Schema gotchas / known issues

- `cover_letters` table is missing a `provider` column. Add it if you want provider tracking restored.
- Supabase destructure pattern: `const { data, error } = await supabase.from(...)...` — always destructure `error` and check it. Silently dropping `error` was the root cause of two bugs this session.
- The repo is on Windows — git will warn about LF→CRLF on every commit. Ignore.

## 9. Test paths Tom uses

- JLR Senior Manager role was the most recent quality test for cover letters.
- He generates a letter, reads paragraph 3 carefully, and flags any AI tells.

## 10. Useful commands

```bash
# From C:\Users\tomlu\OneDrive\Desktop\Money\Job hunt SaaS\job-hunt-dashboard

# Type check
npx tsc --noEmit

# Local dev
npm run dev

# Deploy to prod (Tom's standard flow)
git add <files> && git commit -m "..." && git push
npx vercel@latest deploy --prod --yes

# Tail prod logs
npx vercel@latest logs job-hunt-dashboard-two.vercel.app
```

## 11. First message on the new account

Show the new Claude this:

> Read `C:\Users\tomlu\OneDrive\Desktop\Money\Job hunt SaaS\job-hunt-dashboard\HANDOFF.md` and `C:\Users\tomlu\OneDrive\Desktop\Money\TOM_BRAIN.md` before responding. Then continue from where the last session left off — most recent commit is `dd57a84`. Confirm you've read both files and tell me the next thing on the pending queue.
