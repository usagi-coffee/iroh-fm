---
name: land
description: Land changes to local/master. Invoke only when the user explicitly requests landing.
metadata:
  delta-action: land
---

# Land

The invocation authorizes landing; do not ask again or push `origin`. This skill
only lands the current change: do not review, retest, or otherwise modify it before landing.

First, rebase the current branch onto it.

```sh
git fetch local && GIT_EDITOR=true git rebase local/master
```

Now there are a few scenarios:

1. It rebases cleanly.
2. Git reports `cannot rebase: Your index contains uncommitted changes.` - commit the changes properly then retry the rebase.
3. Git reports a conflict, resolve the conflict and stop only if cannot be resolved cleanly.

After the rebase succeeds, merge fast-forward onto `local/master`:

```sh
git -C "$(git remote get-url local | sed 's#/.git$##')" switch master
git -C "$(git remote get-url local | sed 's#/.git$##')" \
  fetch "$(git rev-parse --show-toplevel)" HEAD
GIT_EDITOR=true git -C "$(git remote get-url local | sed 's#/.git$##')" \
  merge --ff-only FETCH_HEAD
```

