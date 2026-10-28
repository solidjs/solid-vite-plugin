# Publishing the legacy stub (maintainer notes — not shipped to npm)

This directory is deliberately **outside the pnpm workspace** (`pnpm-workspace.yaml`
lists only `.` and `examples/*`), so `changeset publish` in the release workflow can
never see or publish it. It is a one-off manual publish.

Order matters — publish the stub only **after** `@solidjs/vite-plugin` exists on npm
at the version its dependency range needs (`^3.0.0-next.27`):

```bash
cd legacy-stub
npm publish --tag next --otp=<code>
```

- `--tag next` keeps the old package's dist-tags consistent: `vite-plugin-solid@next`
  moves from `3.0.0-next.26` to this stub. Do NOT publish to `latest` while the new
  package is still in prerelease (old-name `latest` stays on the 2.x line).
- The old name's npm trusted-publishing config still exists but does not block a
  manual OTP publish (unless "require trusted publisher" was enabled on npm — it
  wasn't at the time of writing).
- No `npm deprecate` — the README banner and package description carry the notice.
- When `@solidjs/vite-plugin@3.0.0` (stable) ships, optionally re-publish this stub
  as `3.0.0` (bump `version` here; the `^3.0.0-next.27` dependency range already
  matches stable 3.0.0) and move the old name's `latest` tag to it.
- Bump this stub's `version`/dependency floor only if the first published version of
  `@solidjs/vite-plugin` ends up different from `3.0.0-next.27`.
