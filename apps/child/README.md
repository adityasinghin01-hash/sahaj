# Minimal Template

This is a [React Native](https://reactnative.dev/) project built with [Expo](https://expo.dev/) and [React Native Reusables](https://reactnativereusables.com).

It was initialized using the following command, then the `Minimal (Nativewind)` template was selected when prompted:

```bash
npx @react-native-reusables/cli@latest init
```

## Getting Started

To run the development server:

```bash
    npm run dev
    # or
    yarn dev
    # or
    pnpm dev
    # or
    bun dev
```

This will start the Expo Dev Server. Open the app in:

- **iOS**: press `i` to launch in the iOS simulator _(Mac only)_
- **Android**: press `a` to launch in the Android emulator
- **Web**: press `w` to run in a browser

You can also scan the QR code using the [Expo Go](https://expo.dev/go) app on your device. This project fully supports running in Expo Go for quick testing on physical devices.

## Adding components

You can add more reusable components using the CLI:

```bash
npx react-native-reusables/cli@latest add [...components]
```

> e.g. `npx react-native-reusables/cli@latest add input textarea`

If you don't specify any component names, you'll be prompted to select which components to add interactively. Use the `--all` flag to install all available components at once.

## Project Features

- ⚛️ Built with [Expo Router](https://expo.dev/router)
- 🎨 Styled with [Tailwind CSS](https://tailwindcss.com/) via [Nativewind](https://www.nativewind.dev/)
- 📦 UI powered by [React Native Reusables](https://github.com/founded-labs/react-native-reusables)
- 🚀 New Architecture enabled
- 🔥 Edge to Edge enabled
- 📱 Runs on iOS, Android, and Web

## Learn More

To dive deeper into the technologies used:

- [React Native Docs](https://reactnative.dev/docs/getting-started)
- [Expo Docs](https://docs.expo.dev/)
- [Nativewind Docs](https://www.nativewind.dev/)
- [React Native Reusables](https://reactnativereusables.com)

## Deploy with EAS

The easiest way to deploy your app is with [Expo Application Services (EAS)](https://expo.dev/eas).

- [EAS Build](https://docs.expo.dev/build/introduction/)
- [EAS Updates](https://docs.expo.dev/eas-update/introduction/)
- [EAS Submit](https://docs.expo.dev/submit/introduction/)

---

If you enjoy using React Native Reusables, please consider giving it a ⭐ on [GitHub](https://github.com/founded-labs/react-native-reusables). Your support means a lot!

## C-06 lab login and live Shield

On the Shield server, set `SUPABASE_JWT_SECRET` to a secret of at least 32 characters.
Apply core_stub.sql, all migrations sorted by filename, then seed_demo.sql in a disposable lab database.
The existing seed links Riya to auth UUID `33333333-3333-4333-8333-333333333332`; no additional auth seed is necessary.
From `apps/shield-api`, run `node scripts/mint-lab-token.mjs 33333333-3333-4333-8333-333333333332`
with that server secret in the shell environment. Paste the printed 12-hour bearer token and the server URL into
Sign in in the child app. Never paste the signing secret into the app. Production can replace the paste form
with Supabase Auth issuing HS256 authenticated access tokens using the same server secret.
The server may set `APP_ALLOWED_ORIGINS` to comma-separated web origins for cross-origin web previews.

No URL/token selects the existing labelled Demo screens. A signed-in session selects live Shield screens;
connection errors remain errors rather than substituting synthetic results. Core 2 remains a labelled demo.
Native secure storage and push registration are unavailable in this dependency set: neither expo-secure-store
nor expo-notifications is installed. Web stores the lab session in localStorage with guarded access; native
sessions remain in memory until those modules are deliberately added in a separate native build task.

Pair-code creation requires an `Idempotency-Key` header (8–100 URL-safe characters); the typed client supplies it.
A retry with the same family, user and key replays the same code using an encrypted 12-hour cache entry.
The pairing table still stores only code hashes. The app shows the code only on the pairing screen.
Push needs both `EXPO_PUSH_ENABLED=1` and stored child tokens. Sarvam needs `SARVAM_OUTBOUND_ENABLED=1`,
org/workspace/key, purpose-specific agent IDs, connection ID, agent phone number and a verified webhook URL.
The new providers record accepted, failed or unknown delivery claims in dev_outbox and never automatically
repeat an ambiguous request. Provider callback reconciliation belongs to the server webhook owner.

`frauds_stopped` currently counts red warnings that have not been marked safe. The UI labels that meaning:
it is not proof of money saved. Alert warning text is shown only when recorded; missing wording and missing
physical playback confirmation remain explicit. Evidence is masked even for the child because the current
runtime never stores original messages or numbers. On native, Copy for 1930 opens the share sheet if a
clipboard implementation is unavailable; selectable text remains visible.
