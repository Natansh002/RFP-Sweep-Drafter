---
name: rfp-response-writer
description: Draft, review and learn RFP/RFI answers the way our SME-reviewed responses are written. Use when drafting responses to an RFP question set, preparing an SME review workbook, applying SME edits, checking a response before submission, or turning a completed SME review into reusable knowledge. Triggers on "draft the answers", "SME review", "send to SMEs", "learn from this response", "is this ready to submit".
---

# RFP response writer

Learned from a completed, SME-reviewed ERP RFP response (55 questions, 8 sections).
The reviewed answers themselves live only in `library/private/knowledge.local.json`
(gitignored); this skill holds the method, not the content.

## The answer pattern

Every answer is 2–4 short paragraphs, about 150–220 words:

1. **Approach, in the buyer's own terms.** Name the buyer's processes, systems and
   people as the RFP does ("the buyer's approval authority matrix", their ILS, their
   payroll system). No generic opening about the company.
2. **Every sub-ask, in the order asked.** Split the question into its asks
   ("explain how…", "describe…", "include…") and answer each one. The drafter's
   skeleton lists them.
3. **An anonymized comparable example with a measurable outcome.** "At a comparable
   [sector, country] organization, [what changed], saving [approved metric]." Never
   name a customer, and use only metrics from an approved source.
4. **Artifacts, when requested:** "A sample … is included in the supplementary materials."

## House rules (from SME edits)

- **Never name a customer.** The most frequent SME edit was "remove customer names".
  Use type + region: "a regional public sector agency in the United States". The
  red-team check blocks named organizations.
- **Be honest about gaps.** "We do not have direct integration experience with X.
  Relevant comparable experience includes …", then the closest pattern.
- **Say what is standard and what is not.** Included in the standard solution, needs
  additional configuration, or needs extra licensing (e.g. Power BI, Copilot).
- **Keep delivery facts consistent across answers:** governance cadence (bi-weekly
  status, monthly steering committee), formal change requests, phase gates with sign-off
  by both parties, the hypercare period, configuration over customization.
- **Product on platform:** explain what the product adds on top of the platform, in
  the product, not bolted on.
- **Numbers, references and certifications only from an approved source.** Otherwise
  mark `[SME validation required]`.

## Workflow

1. Load the RFP in **Analyze a document** (or open a swept opportunity). Numbered
   questions ("1.0.4 Describe…") become response items with their RFP numbers.
2. **Draft response.** Approved knowledge answers are reused with `{buyer}` filled in
   and cited (`[source: knowledge <id>, reviewed <date>]`). Anything else gets the
   pattern skeleton for the owning SME.
3. **Export SME review (.xlsx):** # | Section | SME | Question | Draft Answer | SME
   Notes / Edits | Status (Not started, In review, Approved, Needs edit, Question for
   vendor), with an Instructions sheet listing open items.
4. SMEs edit; **Import SME review** applies their answers, notes and status.
5. **Red-team** must read Ready (all questions Approved/Final, no SME markers, no stale
   sources, no named customers) before a person approves submission.
6. After submission, **learn** from the final review so the next response starts
   from it:

```bash
npm run learn -- --file "path/to/SME_Review.xlsx"
```

The buyer's name becomes `{buyer}`; items the instructions list as still open are
saved without a review date, so they show as STALE until confirmed. Learned answers can
carry buyer-specific facts (their systems, volumes, entity counts): the drafter cites
them, and the SME confirms or removes those facts for the next buyer.
