# Portable dependency checkout

Refs #55. Agent Code's clean macOS and Linux installs fail before tests because
main tracks a dependency-directory symlink into an author-local sibling worktree.

1. Remove only the tracked `node_modules` symlink; never touch its target.
2. Change the ignore rule to cover the symlink form as well as directories, with
   a WHY comment documenting why a directory-only rule is insufficient.
3. Check the Git index and ignore behavior, then run clean-install package CI.
   Existing clean installation is the regression check: it must succeed without
   any sibling checkout or extra preparatory unlink step.
4. Keep the consumer pin upgrade blocked until this upstream repair is approved
   and merged. No dependency versions or runtime behavior change here.
