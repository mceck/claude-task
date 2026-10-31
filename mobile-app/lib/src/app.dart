import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:fleather/fleather.dart' show FleatherLocalizations;

import 'api.dart' as api;
import 'auth_view.dart';
import 'controller.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';
import 'workspace.dart';
import 'voice_widgets.dart';

class TaskApp extends StatefulWidget {
  final TaskController controller;
  const TaskApp({super.key, required this.controller});
  @override
  State<TaskApp> createState() => _TaskAppState();
}

class _TaskAppState extends State<TaskApp> with WidgetsBindingObserver {
  /// Bumped on every return to the foreground, so the connection notice
  /// starts its delay again instead of flashing while the app reconnects.
  int _resumeEpoch = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    widget.controller.appVisible = state == AppLifecycleState.resumed;
    if (state == AppLifecycleState.resumed && widget.controller.user != null) {
      setState(() => _resumeEpoch++);
      widget.controller.reconnect();
      widget.controller.conversationShown();
    }
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Claude Task',
    debugShowCheckedModeBanner: false,
    theme: buildTheme(),
    localizationsDelegates: const [FleatherLocalizations.delegate],
    home: AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final c = widget.controller;
        final Widget page = c.booting
            ? const _Splash(key: ValueKey('boot'))
            : c.user == null
            ? AuthView(key: const ValueKey('auth'), controller: c)
            : c.user!.mustChangePassword
            ? AuthView(
                key: const ValueKey('password'),
                controller: c,
                changePassword: true,
              )
            : Workspace(key: const ValueKey('workspace'), controller: c);
        final offline =
            c.user != null && c.connection != api.ConnectionState.connected;
        return Scaffold(
          drawer:
              c.user != null &&
                  !c.user!.mustChangePassword &&
                  MediaQuery.sizeOf(context).width < 1000
              ? AppDrawer(controller: c, host: context)
              : null,
          // All four edges: on edge-to-edge Android and notched devices
          // screens must not draw under the cutout or system navigation bar.
          body: SafeArea(
            child: Column(
              children: [
                _ConnectionNotice(
                  lost: offline && !c.booting,
                  epoch: _resumeEpoch,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                    child: Notice(
                      icon: c.connection == api.ConnectionState.offline
                          ? Icons.cloud_off_rounded
                          : Icons.sync_rounded,
                      message: c.connection == api.ConnectionState.offline
                          ? 'Offline · loaded conversations and drafts are available'
                          : 'Reconnecting…',
                      actionLabel: 'Reconnect',
                      onAction: c.reconnect,
                    ),
                  ),
                ),
                _Reveal(
                  visible: c.error != null,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                    child: Notice(
                      icon: Icons.error_outline_rounded,
                      color: Palette.danger,
                      message: c.error ?? '',
                      messageKey: c.error == null
                          ? null
                          : const Key('error-banner'),
                      onClose: c.clearError,
                    ),
                  ),
                ),
                Expanded(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 280),
                    switchInCurve: Curves.easeOutCubic,
                    switchOutCurve: Curves.easeInCubic,
                    child: page,
                  ),
                ),
                if (c.user != null && !c.user!.mustChangePassword)
                  VoiceControls(
                    voice: c.voice,
                    onOpenTask: () => perform(
                      context,
                      () =>
                          c.openNotification(c.voice.room!['taskId'] as String),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    ),
  );
}

/// How long a disconnection must last before the notice appears. Starting the
/// app or coming back to the foreground reconnects at once, and a quick
/// reconnection must not flash the notice.
const connectionNoticeDelay = Duration(seconds: 2);

class _ConnectionNotice extends StatefulWidget {
  /// Signed in and the live connection isn't up.
  final bool lost;

  /// Changes when the app returns to the foreground.
  final int epoch;
  final Widget child;
  const _ConnectionNotice({
    required this.lost,
    required this.epoch,
    required this.child,
  });

  @override
  State<_ConnectionNotice> createState() => _ConnectionNoticeState();
}

class _ConnectionNoticeState extends State<_ConnectionNotice> {
  Timer? _timer;
  bool _visible = false;

  @override
  void initState() {
    super.initState();
    _restart();
  }

  @override
  void didUpdateWidget(covariant _ConnectionNotice old) {
    super.didUpdateWidget(old);
    if (widget.lost != old.lost || widget.epoch != old.epoch) _restart();
  }

  /// Hides the notice and, while the connection is lost, starts its delay
  /// again: a reconnection that takes a moment must not flash it.
  void _restart() {
    _timer?.cancel();
    _timer = null;
    _visible = false;
    if (widget.lost) {
      _timer = Timer(connectionNoticeDelay, () {
        if (mounted) setState(() => _visible = true);
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      _Reveal(visible: widget.lost && _visible, child: widget.child);
}

class _Reveal extends StatelessWidget {
  final bool visible;
  final Widget child;
  const _Reveal({required this.visible, required this.child});
  @override
  Widget build(BuildContext context) => AnimatedSize(
    duration: Motion.medium,
    curve: Motion.enter,
    alignment: Alignment.topCenter,
    child: visible ? child : const SizedBox(width: double.infinity),
  );
}

class _Splash extends StatelessWidget {
  const _Splash({super.key});
  @override
  Widget build(BuildContext context) => const Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        FadeSlideIn(
          scale: .6,
          offset: Offset.zero,
          duration: Motion.slow,
          child: BrandMark(size: 56),
        ),
        SizedBox(height: 28),
        Spinner(),
      ],
    ),
  );
}

Future<void> perform(
  BuildContext context,
  Future<void> Function() action,
) async {
  try {
    await action();
  } catch (e) {
    if (context.mounted) toast(context, e.toString());
  }
}
