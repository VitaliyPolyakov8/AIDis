# Your own app builds

[Back to README](../../README.md) · [Русский](../ru/build-your-own-app.md)

The official Windows app works with every AIDis server, so most owners never need this. Build your
own when you maintain a fork with changes in the app, or want the app to update from your own
repository.

## 1. Point the app at your repository

In your fork, edit `Desktop/desktop.config.json`:

```json
{ "github": { "owner": "your-github-name", "repo": "AIDis" } }
```

and the same names in `Desktop/package.json` under `build.publish`. The app updates from the
Releases of that repository. Set `owner` to `OWNER` to build an app without automatic updates.

If your builds should install **next to** the official app instead of replacing it, also change
`build.appId` in `Desktop/package.json` (for example `io.github.yourname.aidis`) and `APP_ID` in
`Desktop/src/main/config.ts` to the same value. Keep it unchanged afterwards: updates, notifications
and autostart depend on it.

## 2. Build

On Windows 10/11 with Node.js 20.19 or newer (24 recommended):

```bash
cd Client
npm ci
cd ../Desktop
npm ci
npm test
npm run desktop:build
```

The result is in `Desktop/dist`: `AIDis-Setup-<version>.exe`, `AIDis-Setup-<version>.exe.blockmap`
and `latest.yml`.

## 3. Publish

1. Raise `version` in `Desktop/package.json` for every release (the updater compares versions).
2. On GitHub: **Releases -> Draft a new release**, tag `v<version>` (for example `v1.0.1`).
3. Attach the three files from `Desktop/dist` and publish.

Apps of your users find the release within an hour and offer the update.

## Code signing

Unsigned installers show the SmartScreen warning ("Windows protected your PC"). With a code-signing
certificate, configure `build.win` signing in `Desktop/package.json` as described in the
electron-builder documentation. The warning fades as a signed app gains reputation.

## License

AIDis is AGPL-3.0. If you distribute changed builds, publish the changed source code under the same
license (a public fork on GitHub does that).
