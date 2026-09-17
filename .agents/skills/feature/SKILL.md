---
name: feature
description: Steps to take when handling a feature prompt. Use whenever user prompts to create a new feature.
---

# Feature

After gathering context and before coding use this skill.

After implementation before yielding:

- Run all tests in the affected package/module, not only those targeted by the change.
- Is a new feature covered in tests? Check whether tests (backend ones and e2e) cover the feature; if not, add a regression test.
- Read the `contributing` skill and commit the completed feature.
