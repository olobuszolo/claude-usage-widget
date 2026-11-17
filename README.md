# claude-usage-widget

An iPhone widget that shows your Claude Code usage. A small agent on your laptop reads the active
5h window with [ccusage](https://github.com/ryoppippi/ccusage) and stores it in Supabase; the widget reads it back.

```
laptop (launchd -> agent/send-usage.mjs -> ccusage) -> Supabase -> iPhone widget (SwiftUI)
```

## Setup

1. **Supabase:** create a project and run `supabase/schema.sql` in the SQL Editor.
2. **Agent:** `cp agent/.env.example agent/.env`, fill in the project URL and the secret key
   (never commit it), then run `agent/install.sh` to schedule it every 2 minutes
   (`agent/uninstall.sh` removes it).
3. **Widget config:** `cp app/targets/widget/Config.swift.example app/targets/widget/Config.swift`
   and fill in the project URL and the publishable key. `Config.swift` is gitignored.
4. **App:** in `app/`, run `npm install`, set `ios.appleTeamId` in `app.json`, then
   `npx expo prebuild -p ios --clean` and build to your device with Xcode
   (`export LANG=en_US.UTF-8` first, otherwise CocoaPods fails on encoding).

Requires iOS 17+, Xcode, and Node 22+.
