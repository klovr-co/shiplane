<!-- shiplane:start v{{version}} -->
## Shipping (managed by shiplane; settings in .agents/config.yml)
{{hookLine}}
1. Work in your own worktree from a fresh origin/{{shipBranch}}. Never push to it, merge by hand, or deploy by hand.
2. Before shipping: the pre-push check passes (never --no-verify), another agent has reviewed the diff, and UI changes have screenshots on the PR.
3. Push everything first, then ship: a push after shipping cancels the queue place (shiplane refuses while this checkout has unpushed commits). A head sha that Mergify dequeued for failed CI is not queued again until a new commit is pushed. Ship with `node .agents/shiplane/shiplane.mjs <pr> --background` in a background shell, from the repo root (an installed `shiplane <pr>` is the same; "shiplane <pr>" in its messages means either). Don't ask the user first. If the config sets `queueCheckCommand`, it first runs that full check (on a clean checkout of the PR head: stay on the PR branch, committed), again after each push. It queues, re-queues after pushes, waits for merge and deploy, and prints one result line when it exits. Then check the live URL and report once, with a screenshot.
4. Exception: anything matching `needsOwner` in the config gets the `needs-owner` label and the line "Needs owner: <the decision>" in the `> [!IMPORTANT]` box at the top of the PR. When the user says yes, remove `needs-owner`, add `approved` (shiplane refuses owner-only files without it), then ship.
5. The user's verb doesn't matter. "it" = this PR · "all" = your last list (needs-owner ones included: "all" is the yes) · "except #X"/"hold #X" = add `hold` to X · "now" = `--now` on the most important one.
6. UI change: write the acceptance rules in 2–3 lines first; ask only if the request can be read two ways.
7. Never claim what you didn't check; say "not checked". Report data work as N of M.
8. When you need the user: one question, with what you'll do if they don't answer. Don't repeat it. A decision on a PR goes on the PR too (`needs-owner`, and "Needs owner: <the question>" in the `> [!IMPORTANT]` box at the top): GitHub tells the owners. What waits for them (PRs or issues labelled `needs-owner` or `hold`): `gh needs-me` (after `shiplane setup`), or in a browser {{needsMeUrl}}
9. Wait with `--background`, never with a PR watch alone (T3's PR watch ends at merge without waking you). You are woken when it exits, so don't poll or sleep (`node .agents/shiplane/shiplane.mjs <pr> --status` shows progress).
### Pull requests
Write each PR for the owner, who checks behaviour, not code. Use .github/pull_request_template.md.
- Language: ASD-STE100. A maximum of 20 words in a sentence, 1 fact in a sentence, active voice, the same word for the same thing, each fact 1 time. Write for a junior developer: the reason and 1 example, no more. Function names, file names and internal codes go only in "How it works".
- Top: "What I need from you" in a `> [!IMPORTANT]` box when the owner must act (a decision is "Needs owner: <question>"), or a `> [!NOTE]` box with "Nothing. Safe to merge." Keep the visible part below 150 words.
- Size: a maximum of 3 fixes in 1 area of the app, and approximately 400 changed lines without tests. If it is larger, split it.
- Commits: 1 commit for each fix, in the order of "What changes". Put each review fix into its commit (`git commit --fixup <sha>`, then `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/{{shipBranch}}`). Rebase on origin/{{shipBranch}}; do not merge it into the branch.
- Diagrams: add a Mermaid diagram when the PR changes a rule, a flow, a status or an API call: `sequenceDiagram` for API calls, `stateDiagram-v2` for a status, `flowchart` before and after for a rule, `erDiagram` for tables, `timeline` for dates. A maximum of 2, each with 1 real example below it. Show changed parts with `classDef changed fill:#f59e0b33,stroke:#f59e0b,stroke-width:2px`. Open the PR and make sure that the diagram shows.
<!-- shiplane:end -->
