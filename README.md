# claude-usage-widget

An iPhone widget that shows your Claude Code usage. A small agent on your laptop reads the active
5h window with [ccusage](https://github.com/ryoppippi/ccusage) and stores it in Supabase; the widget reads it back.

```
laptop (launchd -> agent/send-usage.mjs -> ccusage) -> Supabase -> iPhone widget (SwiftUI)
```

## Setup

Everyone uses their own Supabase project; nothing is hardcoded.

1. **Supabase:** create a free project. From its dashboard you need four values:
   the project URL, the **secret key** and **publishable key** (Settings -> API Keys), and the
   **Session pooler** connection string (Connect -> Session pooler; the direct host is IPv6-only on many networks).
2. **Mac:** run the setup tool and answer the prompts.

   ```bash
   cd agent && npm install
   node cli.mjs setup
   ```

   It creates the tables and the read-only `latest_usage()` function (safe to re-run, versioned in
   `supabase/schema.sql`), stores the secret key in the macOS Keychain, installs a launchd job that
   sends a snapshot every 2 minutes, and prints a **pairing QR code**.
   The connection string is used once and never saved.
3. **iPhone:** build the app in `app/` (see below), open it and scan the QR code. The app saves the URL and
   publishable key to a shared App Group, and the widget reads them from there. You can also type them in.

Other commands: `node cli.mjs qr` (show the QR again), `status` (agent, config and last data),
`uninstall [--purge]` (remove the agent, and optionally the saved config and Keychain item).

### Building the iOS app

In `app/`, run `npm install`, set `ios.appleTeamId` in `app.json`, then `npx expo prebuild -p ios`
and build to your device (`export LANG=en_US.UTF-8` first, otherwise CocoaPods fails on encoding).
The App Group (`group.com.aleksanderbuszek.claudeusage` in `app.json` and the widget target config) needs
your Apple ID added in Xcode (Settings -> Accounts); a free Personal Team works but expires every 7 days.

Requires iOS 17+, Xcode, and Node 22+.
