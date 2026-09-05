# Restore container package resolution

Refs #57. Container CI cannot resolve three exact Alpine 3.23 runtime pins.

1. Verify replacement revisions against Alpine's official package metadata for
   both supported architectures; change only unavailable libcurl, libexpat and
   pcre2 revisions. Keep the base-image digest and exact dependency closure.
2. Document why repository churn is intentionally a build failure, not a reason
   to float package versions or disable the image gate.
3. Run the existing container image/launcher contracts in disposable CI, not the
   local Bringdown VM. Package tests must remain green. Release multiarch and
   security qualification remain separate gates, not inferred from amd64 CI.
