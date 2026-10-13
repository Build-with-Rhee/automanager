# Windows event context bridge

Build on Windows 10/11 x64 with Node.js, Visual Studio 2022 C++ Build Tools and the Windows SDK:

```powershell
npm ci
npm run native:win
npm run build
npm run package:win
```

`windows_context.node` uses stable Node-API version 8. Packaging copies it to `resources/native`; Electron loads it in a dedicated action process. The main build must include `src/platform/platform-worker.ts` as the `platform-worker` entry alongside main/index.

The native hook freezes the hit window HWND/PID/title before a click reaches its target, and freezes the foreground HWND for keyboard navigation. A bounded ThreadSafeFunction forwards events. Ordinary characters are rejected in native code. The hook never requests UI Automation text/value patterns or clipboard data.

Named UI controls are best effort: a separate helper queries UI Automation with a process boundary and deadline. If the original HWND/PID or point target changed, metadata is omitted. Password, editable, document and text-control names are omitted. UAC/secure desktop, locked desktop and elevated-app metadata are not promised. Windows 7, ARM64 and macOS capture are unsupported. Linux X11 uses sampled metadata; Wayland and headless input capture are unsupported.

Before release, verify on an actual Windows host:

- Click a background application and verify the step names its original target, including focus changes.
- Exercise left/right/middle click, double click, drag, both scroll axes and Ctrl/Alt/Win/navigation shortcuts.
- Type ordinary text into a text editor and password field; inspect persisted steps and confirm no typed text/password value is present.
- Open an application whose UI Automation provider stalls; recording must continue with a visible metadata warning.
- Close the controller to the tray, pause/resume/stop, and confirm no input hook or helper process remains after explicit Quit.
- Exercise mixed-DPI monitors with negative coordinates; verify screenshot mapping in the application integration.
- Run the installed NSIS build, including native-addon loading, across Windows 10 and Windows 11.

Compilation and runtime capture have not been verified from the Linux onboarding machine.
