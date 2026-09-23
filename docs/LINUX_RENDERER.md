# Linux renderer and shutdown

## Default from 0.2.1

On Linux, Operator Key sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` in its own process before starting Tauri/GTK/WebKit, but only when the variable is absent. It does not change your shell, desktop configuration, installed graphics libraries, normal close handling, or coredump settings. Other platforms are unchanged.

This disables accelerated compositing for this app. It is a stability mitigation with a possible rendering-performance/CPU tradeoff, not a fix to WebKit or Mesa internals and not a guarantee that no graphics libraries load. Operator Key is primarily a text-and-command interface rather than a video/WebGL application.

Explicit environment values are preserved. To compare the accelerated path deliberately:

```sh
WEBKIT_DISABLE_COMPOSITING_MODE=0 operator-key
```

To force the conservative path explicitly:

```sh
WEBKIT_DISABLE_COMPOSITING_MODE=1 operator-key
```

Close the previous instance first. The accelerated override can reintroduce the shutdown failure on affected systems. Do not apply global graphics workarounds just to run Operator Key.

## Evidence and limits

On the investigated Arch/Hyprland desktop (WebKitGTK 2.52.6, Mesa 26.2.2, libglvnd 1.7.0), renderer shutdown intermittently produced heap-corruption SIGSEGV/SIGABRT reports involving EGL/Mesa or allocator workers. The previous 0.1.0 binary also reproduced a renderer crash after a two-minute interactive session and normal compositor close; it was not introduced by the 0.2.0 UI redesign. The parent process could exit successfully while its renderer subsequently crashed.

Controlled comparisons using the compositing override completed normal close without attributed renderer crashes on both the previous and current binaries, including longer interactive sessions. These observations support an app-scoped mitigation; they do not identify an exact upstream defective instruction or certify every Linux driver combination.

Keep checking native search/copy/insertion, normal Escape and compositor close, both short and longer sessions, and post-exit renderer outcomes. Correlate coredumps to recorded parent/renderer PIDs and allow delayed coredump processing to finish. An immediate empty coredump listing is not adequate proof. Do not confuse an automation focus/query error with a renderer shutdown failure.

## References

- [Tauri Linux graphics troubleshooting](https://v2.tauri.app/develop/debug/linux-graphics/)
- [WebKit hardware acceleration manager](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/gtk/HardwareAccelerationManager.cpp)
- [Investigation #13](https://github.com/kevynshorey/operator-key/issues/13)
