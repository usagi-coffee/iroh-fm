---
name: bugfix
description: Steps to take when handling a bugfix prompt. Use whenever user prompts to create a bugfix.
---

# Bugfix

After gathering context and before implementing a fix:

- Add a regression test targeting the bug.
- Run tests to check if the regression is real

After implementing a fix before yielding:

- Run all tests in the affected package/module, not only those targeted by the fix.
- Read the `contributing` skill and commit the completed fix.
