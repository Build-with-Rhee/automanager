# Windows build and Linux cross-build assessment

Use `npm run native:win` on Windows 10/11 x64 with Visual Studio 2022 C++ Build Tools and the Windows SDK. The Windows CI workflow at `.github/workflows/windows.yml` installs locked dependencies, runs this native build, checks the module's Node-API exports, runs tests and typecheck, and packages/uploads an x64 NSIS installer plus `windows_context.node`.

The Windows build uses node-gyp's default MSVC delay-load hook. This matters because Node/Electron's import library imports `node.exe`, while the installed application is named `Automanager.exe`. The hook resolves Node-API exports against the running host executable. Stable Node-API version 8 avoids dependence on V8 ABI headers.

Linux cross-compilation was investigated using the official Debian signed repository's MinGW-w64 x64 POSIX toolchain and Electron 44.7.0's official header distribution. The official `win-x64/node.lib` was downloaded over verified HTTPS and checked against `SHASUMS256.txt`; its SHA256 is `221dac8b3f9e9e7cabb1e782c347399b24f0a68d0778e294ee34714c59d6446e`. Inspection confirmed its imports target `node.exe`.

A direct MinGW link to that library would therefore fail to establish loadability inside the renamed Electron application. node-gyp's supplied delay-load source is guarded by `_MSC_VER` and configured through MSVC linker `DelayLoadDLLs`, so a reliable GNU cross-build would require a separate tested delay-import implementation or an MSVC-compatible cross-toolchain and SDK. No such unverified artifact was placed into `build/Release`.

The workflow is prepared but has not been executed from this Linux machine. Neither a successful Linux application smoke nor future Windows compilation alone establishes Windows global-input, mixed-DPI, elevated-app or UI Automation behavior. Run the target-OS checklist in this directory's README on the installed application before describing Windows capture as validated.
