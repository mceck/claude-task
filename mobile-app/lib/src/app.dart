import 'package:flutter/material.dart';
import 'api.dart' as api;
import 'auth_view.dart';
import 'controller.dart';
import 'workspace.dart';

class TaskApp extends StatefulWidget {
  final TaskController controller;
  const TaskApp({super.key, required this.controller});
  @override
  State<TaskApp> createState() => _TaskAppState();
}

class _TaskAppState extends State<TaskApp> with WidgetsBindingObserver {
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
      widget.controller.reconnect();
    }
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Claude Task',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      brightness: Brightness.dark,
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xff9a8cff),
        brightness: Brightness.dark,
        surface: const Color(0xff1c1d24),
      ),
      scaffoldBackgroundColor: const Color(0xff1c1d24),
      inputDecorationTheme: const InputDecorationTheme(
        border: OutlineInputBorder(),
        filled: true,
      ),
      dividerColor: const Color(0xff343640),
    ),
    home: AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final c = widget.controller;
        if (c.booting) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          );
        }
        return Scaffold(
          body: SafeArea(
            child: Column(
              children: [
                if (c.user != null &&
                    c.connection != api.ConnectionState.connected)
                  Material(
                    color: const Color(0xff4b3b1f),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 4,
                      ),
                      child: Row(
                        children: [
                          Icon(
                            c.connection == api.ConnectionState.offline
                                ? Icons.cloud_off
                                : Icons.sync,
                            size: 18,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              c.connection == api.ConnectionState.offline
                                  ? 'Offline · loaded conversations and drafts are available'
                                  : 'Reconnecting…',
                            ),
                          ),
                          TextButton(
                            onPressed: c.reconnect,
                            child: const Text('Reconnect'),
                          ),
                        ],
                      ),
                    ),
                  ),
                if (c.error != null)
                  Material(
                    color: const Color(0xff4b2833),
                    child: Padding(
                      padding: const EdgeInsets.only(left: 16),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              c.error!,
                              key: const Key('error-banner'),
                            ),
                          ),
                          IconButton(
                            onPressed: c.clearError,
                            icon: const Icon(Icons.close),
                          ),
                        ],
                      ),
                    ),
                  ),
                Expanded(
                  child: c.user == null
                      ? AuthView(controller: c)
                      : c.user!.mustChangePassword
                      ? AuthView(controller: c, changePassword: true)
                      : Workspace(controller: c),
                ),
              ],
            ),
          ),
        );
      },
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
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }
}
