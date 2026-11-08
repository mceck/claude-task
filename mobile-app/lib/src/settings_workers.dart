part of 'settings.dart';

/// The Workers list, open to every User. It follows the Workers topic through
/// the controller, so states and counts change live.
class _WorkersSettings extends StatefulWidget {
  final TaskController controller;
  const _WorkersSettings({required this.controller});
  @override
  State<_WorkersSettings> createState() => _WorkersSettingsState();
}

class _WorkersSettingsState extends State<_WorkersSettings> {
  Object? error;
  bool loaded = false;

  @override
  void initState() {
    super.initState();
    unawaited(reload());
  }

  Future<void> reload() async {
    try {
      await widget.controller.fetchWorkers();
      if (mounted) {
        setState(() {
          loaded = true;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller, workers = c.workers;
      if (!loaded && workers.isEmpty) {
        return AppPage(
          title: 'Workers',
          body: error != null
              ? LoadError(
                  error: error!,
                  onRetry: () {
                    setState(() => error = null);
                    unawaited(reload());
                  },
                )
              : const Center(child: Spinner()),
        );
      }
      return AppPage(
        title: 'Workers',
        subtitle:
            '${workers.length} ${workers.length == 1 ? 'worker' : 'workers'}',
        body: AppRefresh(
          onRefresh: reload,
          child: _list([
            if (error != null) ...[
              Notice.error(error.toString()),
              const SizedBox(height: 12),
            ],
            if (workers.isEmpty)
              EmptyHint(
                c.user?.isAdmin == true
                    ? "No Workers yet. Create one in the web app's Workers section."
                    : 'No Workers yet. Ask an Admin to create one.',
              ),
            for (final w in workers)
              AppTile(
                key: ValueKey('worker-row:${w.id}'),
                leading: const IconBadge(
                  Icons.dns_outlined,
                  color: Palette.info,
                ),
                title: w.name,
                subtitle: [
                  workerSummary(w),
                  if (w.projects.isNotEmpty)
                    w.projects.map((p) => p['name']).join(', '),
                ].join('\n'),
                subtitleLines: 3,
                trailing: workerStateDot(w),
                onTap: () => showWorkerSheet(context, c, w),
              ),
          ]),
        ),
      );
    },
  );
}

/// A Worker's sheet: its Worker Slots with their state, Runner connection and
/// current Job, and the Admin actions. It follows the Worker's topic while it
/// shows.
Future<void> showWorkerSheet(
  BuildContext context,
  TaskController c,
  Worker worker,
) => showAppSheet<void>(
  context,
  maxWidth: 580,
  builder: (_) => _WorkerSheet(controller: c, initial: worker),
);

class _WorkerSheet extends StatefulWidget {
  final TaskController controller;
  final Worker initial;
  const _WorkerSheet({required this.controller, required this.initial});
  @override
  State<_WorkerSheet> createState() => _WorkerSheetState();
}

class _WorkerSheetState extends State<_WorkerSheet> {
  /// The action running now, so its button shows busy and the others wait.
  String? busy;
  String? error;
  late final TaskController c = widget.controller;

  @override
  void initState() {
    super.initState();
    c.watchWorker(widget.initial.id);
    unawaited(
      c.fetchWorker(widget.initial.id).then<void>((_) {}).catchError((
        Object e,
      ) {
        if (mounted) setState(() => error = e.toString());
      }),
    );
  }

  @override
  void dispose() {
    c.watchWorker(null);
    super.dispose();
  }

  Future<void> _run(String key, String path) async {
    setState(() {
      busy = key;
      error = null;
    });
    try {
      await c.workerAction(path);
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = null);
    }
  }

  Future<void> _confirmed(
    String key,
    String path, {
    required String title,
    required String confirmLabel,
  }) async {
    if (!await confirm(
          context,
          title: title,
          message:
              'This interrupts the current Job. Its Session will be resumed '
              'after reconnecting.',
          confirmLabel: confirmLabel,
        ) ||
        !mounted) {
      return;
    }
    await _run(key, path);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final w = c.workers.byId(widget.initial.id) ?? widget.initial;
      final admin = c.user?.isAdmin == true, online = c.online;
      final path = '/workers/${w.id}';
      return SheetScaffold(
        title: w.name,
        subtitle: '${workerSummary(w)} · Host: ${w.hostName}',
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (error != null) ...[
              Notice.error(error!),
              const SizedBox(height: 12),
            ],
            if (w.description.isNotEmpty) ...[
              Text(
                w.description,
                style: const TextStyle(fontSize: 13, color: Palette.fgMuted),
              ),
              const SizedBox(height: 12),
            ],
            if (w.imageState == 'failed') ...[
              const Notice(
                message:
                    'The latest Build failed. Its log is in the web app; '
                    'containers keep the previous image.',
                color: Palette.danger,
                icon: Icons.error_outline_rounded,
              ),
              const SizedBox(height: 12),
            ],
            for (final e in w.profileErrors) ...[
              Notice(
                message: '${e.name}: ${e.error}',
                color: Palette.danger,
                icon: Icons.error_outline_rounded,
              ),
              const SizedBox(height: 12),
            ],
            SectionLabel('Worker Slots · minimum ${w.minimum}, cap ${w.cap}'),
            const SizedBox(height: 8),
            if (w.containers.isEmpty) const EmptyHint('No Worker Slots yet.'),
            for (final slot in w.containers)
              _WorkerSlotRow(
                key: ValueKey('worker-slot:${slot.slot}'),
                controller: c,
                slot: slot,
                actions: !admin
                    ? null
                    : [
                        AppButton(
                          label: 'Restart',
                          tone: Tone.secondary,
                          compact: true,
                          busy: busy == 'restart:${slot.slot}',
                          onPressed:
                              !online || busy != null || slot.state == 'stopped'
                              ? null
                              : () => _confirmed(
                                  'restart:${slot.slot}',
                                  '$path/containers/${slot.slot}/restart',
                                  title: 'Restart slot ${slot.slot}?',
                                  confirmLabel: 'Restart',
                                ),
                        ),
                        AppButton(
                          label: 'Force recreate',
                          tone: Tone.secondary,
                          compact: true,
                          busy: busy == 'force:${slot.slot}',
                          onPressed: !online || busy != null
                              ? null
                              : () => _confirmed(
                                  'force:${slot.slot}',
                                  '$path/containers/${slot.slot}/force-recreate',
                                  title: 'Force recreate slot ${slot.slot}?',
                                  confirmLabel: 'Force recreate',
                                ),
                        ),
                      ],
              ),
            if (admin) ...[
              const Divider(height: 24),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  AppButton(
                    label: 'Rebuild image',
                    tone: Tone.secondary,
                    busy: busy == 'rebuild',
                    onPressed:
                        !online || busy != null || w.imageState == 'building'
                        ? null
                        : () => _run('rebuild', '$path/rebuild'),
                  ),
                  AppButton(
                    label: 'Recreate when idle',
                    tone: Tone.secondary,
                    busy: busy == 'recreate',
                    onPressed: !online || busy != null
                        ? null
                        : () => _run('recreate', '$path/recreate'),
                  ),
                ],
              ),
            ],
          ],
        ),
      );
    },
  );
}

/// One Worker Slot: its state, the container's Docker state and Runner
/// connection, a pending recreation and the Task and Agent of its Job.
class _WorkerSlotRow extends StatelessWidget {
  final TaskController controller;
  final WorkerContainer slot;
  final List<Widget>? actions;
  const _WorkerSlotRow({
    super.key,
    required this.controller,
    required this.slot,
    this.actions,
  });
  @override
  Widget build(BuildContext context) {
    final task = slot.task, agent = slot.agent;
    final lines = [
      '${slot.state} · Docker ${slot.containerState.isEmpty ? 'unknown' : slot.containerState} · '
          'Runner ${slot.runnerConnected ? 'connected' : 'disconnected'}',
      if (task != null)
        '${task.key} ${task.title}${agent == null ? '' : ' · ${agent['name']}'}',
      if (slot.recreatePending)
        'Recreation waits for the current Job to finish.',
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.row),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: Palette.surface,
          border: Border.all(color: Palette.border),
          borderRadius: BorderRadius.circular(Radii.md),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  SizedBox(
                    width: 14,
                    child: Center(child: stateDot(slot.state)),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    'Slot ${slot.slot}',
                    style: const TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                lines.join('\n'),
                style: const TextStyle(
                  fontSize: 12.5,
                  height: 1.4,
                  color: Palette.fgSubtle,
                ),
              ),
              if (actions != null) ...[
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 8, children: actions!),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
