<!---
DO NOT EDIT
-*- Mergify Payload -*-
{"version": 1, "state": "dequeued", "queue_rule_name": "default", "queued_at": "2026-11-25T19:19:49.118584+00:00", "estimated_time_of_merge": null, "speculative_check_pr": null, "required_conditions": [], "left_at": "2026-11-25T20:32:44.193661+00:00", "dequeue_reason": {"code": "PR_DEQUEUED", "label": "pull request dequeued", "message": "Queue conditions are not satisfied"}}
-*- Mergify Payload End -*-
-->

### 🚫 Left the queue · queue conditions no longer match

1 h 13 min in the queue, 9 min of it CI.

**So far**

- ✅ **Entered the queue** Wed 25 Nov, 19:19 · rule `default` · triggered by @mmtmr with the [`@mergifyio queue` command](https://github.com/klovr-co/aldrent/pull/3728#issuecomment-7172142829)
- ❌ **Checks failed** 19:22 · draft [#3768](/klovr-co/aldrent/pull/3768)
  - ❌ [`Merge gate`](https://github.com/klovr-co/aldrent/actions/runs/45684509596)
  - ❌ [`App tests (2/3)`](https://github.com/klovr-co/aldrent/actions/runs/45684509596/job/139453688398) ([job log](https://github.com/klovr-co/aldrent/actions/runs/45684509596/job/139453688398))
  - ❌ [`Backend (typecheck + tests) (2/2)`](https://github.com/klovr-co/aldrent/actions/runs/45684509596/job/139453688692) ([job log](https://github.com/klovr-co/aldrent/actions/runs/45684509596/job/139453688692))
  - ❌ [`Lint + Typecheck + Build`](https://github.com/klovr-co/aldrent/actions/runs/45684509596/job/139458578909) ([job log](https://github.com/klovr-co/aldrent/actions/runs/45684509596/job/139458578909))
- ✂️ Failing PR identified · your PR is not the cause of the failure
- ⏹️ **Testing stopped** · draft [#3814](/klovr-co/aldrent/pull/3814)
- 🚫 **Left the queue** 20:32 · `230b46f`

**Reason**

Pull request [#3728](/klovr-co/aldrent/pull/3728) has been dequeued

Queue conditions are not satisfied:

> - [ ] any of: [🔀 queue conditions]
>   - [ ] all of: [📌 queue conditions of queue rule `default`]
>     - [ ] `label = queue`
>   - [ ] all of: [📌 queue conditions of queue rule `hotfix`]
>     - [ ] `label = hotfix`

**To get back in the queue**

- Push a change if one is needed: the pull request is queued again once its queue conditions match.
- If no change is needed, tick the box below to queue it again as it is.

**Merge conditions not met when it left the queue**

- [ ] `check-success = Merge gate`

Requeue requested — the merge queue status continues in [this comment ↓](https://github.com/klovr-co/aldrent/pull/3728#issuecomment-7174023925).

<sub>Times in UTC · [dashboard](https://dashboard.mergify.com/orgs/klovr-co/repos/aldrent/queues/status?branch=staging&pull=3728) · [how the merge queue works](https://docs.mergify.com/merge-queue/)</sub>
