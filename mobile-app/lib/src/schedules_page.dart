import 'package:material_ui/material_ui.dart';

import 'app.dart';
import 'controller.dart';
import 'models.dart';
import 'schedule_cron.dart';
import 'task_forms.dart';
import 'time_zones.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

/// The Schedules section of the native app (docs/specs/schedules.md): Agents
/// that work on their own, their configuration and their run history. Everyone
/// can read it; only Admins create, edit, pause, start and delete.

const _stateLabels = {
  'running': 'Running',
  'succeeded': 'Succeeded',
  'failed': 'Failed',
  'skipped': 'Skipped',
};

Color _stateColor(String state) => switch (state) {
  'succeeded' => Palette.success,
  'failed' => Palette.danger,
  'skipped' => Palette.fgSubtle,
  _ => Palette.info,
};

String _when(DateTime? value, [DateTime? now]) {
  if (value == null) return '—';
  final d = value.toLocal(), year = (now ?? DateTime.now()).year;
  final months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final time =
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  return '${months[d.month - 1]} ${d.day}${d.year == year ? '' : ', ${d.year}'}, $time';
}

String _duration(ScheduleRun run) {
  final value = run.duration;
  if (value == null) return '';
  final seconds = value.inSeconds;
  if (seconds < 60) return '${seconds}s';
  if (seconds < 3600) return '${(seconds / 60).round()} min';
  return '${(seconds / 3600).toStringAsFixed(1)} h';
}

String _agentName(TaskController c, Schedule s) {
  if (s.agentId == null) return 'No agent';
  return c.agents.byId(s.agentId)?.name ?? 'Deleted agent';
}

String _scope(Schedule s) => s.global ? 'Global' : s.repositoryName;

class ScheduleList extends StatelessWidget {
  final TaskController controller;

  /// The Schedule open on a wide layout, highlighted in the list.
  final String? selectedId;
  const ScheduleList({super.key, required this.controller, this.selectedId});
  @override
  Widget build(BuildContext context) {
    final c = controller, admin = c.user?.isAdmin == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PageHeader(
          leading: const DrawerBrandMark(),
          title: 'Schedules',
          subtitle:
              '${c.schedules.length} ${c.schedules.length == 1 ? 'schedule' : 'schedules'}',
          actions: [
            if (admin)
              IconAction(
                icon: Icons.add_rounded,
                tooltip: 'New schedule',
                filled: true,
                size: 36,
                onPressed: c.online ? () => showScheduleForm(context, c) : null,
              ),
          ],
        ),
        Expanded(
          child: c.schedules.isEmpty
              ? EmptyState(
                  icon: Icons.calendar_month_outlined,
                  title: 'No Schedules',
                  message: 'Schedules let Agents work on their own, at times you choose.',
                  action: admin
                      ? AppButton(
                          label: 'New schedule',
                          icon: Icons.add_rounded,
                          onPressed: c.online
                              ? () => showScheduleForm(context, c)
                              : null,
                        )
                      : null,
                )
              : AppRefresh(
                  onRefresh: () => perform(context, c.refresh),
                  child: PageList(
                    children: [
                      for (final s in c.schedules)
                        _ScheduleRow(
                          key: ValueKey('schedule-row:${s.id}'),
                          controller: c,
                          schedule: s,
                          selected: s.id == selectedId,
                          admin: admin,
                        ),
                    ],
                  ),
                ),
        ),
      ],
    );
  }
}

class _ScheduleRow extends StatelessWidget {
  final TaskController controller;
  final Schedule schedule;
  final bool selected, admin;
  const _ScheduleRow({
    super.key,
    required this.controller,
    required this.schedule,
    required this.selected,
    required this.admin,
  });
  @override
  Widget build(BuildContext context) {
    final c = controller, s = schedule, run = s.lastRun;
    final next = s.enabled ? 'Next ${_when(s.nextRunAt)}' : 'Paused';
    final outcome = run == null
        ? 'Never ran'
        : (_stateLabels[run.state] ?? run.state);
    return AppTile(
      leading: const IconBadge(
        Icons.calendar_month_outlined,
        color: Palette.info,
      ),
      title: s.name,
      subtitle: [
        describeCron(s.cron),
        '${_agentName(c, s)} · ${_scope(s)}${s.readOnly ? ' · read-only' : ''}',
        '$next · $outcome',
      ].join('\n'),
      subtitleLines: 4,
      selected: selected,
      trailing: admin ? _EnabledSwitch(controller: c, schedule: s) : null,
      onTap: () => perform(context, () => c.selectSchedule(s)),
    );
  }
}

/// The Schedule's enabled switch. It keeps its own saving state so a slow save
/// can't be started twice.
class _EnabledSwitch extends StatefulWidget {
  final TaskController controller;
  final Schedule schedule;
  const _EnabledSwitch({required this.controller, required this.schedule});
  @override
  State<_EnabledSwitch> createState() => _EnabledSwitchState();
}

class _EnabledSwitchState extends State<_EnabledSwitch> {
  bool _saving = false;
  @override
  Widget build(BuildContext context) {
    final c = widget.controller, s = widget.schedule;
    return Transform.scale(
      scale: .85,
      child: Switch.adaptive(
        value: s.enabled,
        activeTrackColor: Palette.primary,
        onChanged: c.online && !_saving
            ? (value) async {
                setState(() => _saving = true);
                await perform(context, () => c.setScheduleEnabled(s, value));
                if (mounted) setState(() => _saving = false);
              }
            : null,
      ),
    );
  }
}

class SchedulePage extends StatefulWidget {
  final TaskController controller;
  final VoidCallback? onBack;
  const SchedulePage({super.key, required this.controller, this.onBack});
  @override
  State<SchedulePage> createState() => _SchedulePageState();
}

class _SchedulePageState extends State<SchedulePage> {
  bool _busy = false;

  Future<void> _act(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    await perform(context, action);
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _remove(TaskController c) async {
    if (!await confirm(
      context,
      title: 'Delete schedule?',
      message:
          'Delete this schedule with all its runs and their conversations.',
      confirmLabel: 'Delete schedule',
    )) {
      return;
    }
    await _act(c.deleteSchedule);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, s = c.schedule;
    if (s == null) {
      return const EmptyState(
        icon: Icons.calendar_month_outlined,
        title: 'Select a Schedule',
        message: 'Pick a Schedule to see its configuration and run history.',
      );
    }
    final admin = c.user?.isAdmin == true, busy = _busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PageHeader(
          onBack: widget.onBack,
          title: s.name,
          subtitle:
              '${describeCron(s.cron)} (${s.timeZone}) · ${_agentName(c, s)} · '
              '${_scope(s)}${s.readOnly ? ' · read-only' : ''}',
          actions: [
            if (admin) ...[
              IconAction(
                icon: Icons.play_arrow_rounded,
                tooltip: 'Run now',
                filled: true,
                size: 34,
                onPressed: c.online && !busy
                    ? () => _act(c.runScheduleNow)
                    : null,
              ),
              IconAction(
                icon: s.enabled
                    ? Icons.pause_rounded
                    : Icons.play_circle_outline_rounded,
                tooltip: s.enabled ? 'Pause' : 'Resume',
                onPressed: c.online && !busy
                    ? () => _act(() => c.setScheduleEnabled(s, !s.enabled))
                    : null,
              ),
              Builder(
                builder: (anchor) => IconAction(
                  icon: Icons.more_horiz_rounded,
                  tooltip: 'Schedule actions',
                  onPressed: () async {
                    final action = await showActions<String>(anchor, [
                      const ActionItem(
                        'edit',
                        'Edit schedule',
                        Icons.edit_outlined,
                      ),
                      const ActionItem(
                        'delete',
                        'Delete schedule',
                        Icons.delete_outline_rounded,
                        destructive: true,
                      ),
                    ], title: s.name);
                    if (action == 'edit' && anchor.mounted) {
                      await showScheduleForm(anchor, c, schedule: s);
                    } else if (action == 'delete' && anchor.mounted) {
                      await _remove(c);
                    }
                  },
                ),
              ),
            ],
          ],
        ),
        Expanded(
          child: AppRefresh(
            onRefresh: () => perform(context, () => c.selectSchedule(s)),
            child: PageList(
              children: [
                Section(
                  title: 'Schedule',
                  children: [
                    _InfoLine(
                      label: 'Next run',
                      value: s.enabled ? _when(s.nextRunAt) : 'Paused',
                    ),
                    _InfoLine(label: 'Agent', value: _agentName(c, s)),
                    _InfoLine(
                      label: 'Scope',
                      value: s.global
                          ? 'Global: the Agent works on the boards'
                          : s.repositoryName,
                    ),
                    _InfoLine(label: 'Time zone', value: s.timeZone),
                    _InfoLine(
                      label: 'Git',
                      value: s.readOnly
                          ? 'Read-only: pushes are refused'
                          : 'Read and write',
                    ),
                    if (s.createdBy != null)
                      _InfoLine(
                        label: 'Created by',
                        value: s.createdBy!.displayName,
                      ),
                    if (s.consecutiveSkips > 0)
                      _InfoLine(
                        label: 'Skipped',
                        value:
                            '${s.consecutiveSkips} time${s.consecutiveSkips == 1 ? '' : 's'} in a row',
                        warning: true,
                      ),
                  ],
                ),
                Section(
                  title: 'Prompt',
                  description: 'Posted as the first message of every run.',
                  children: [
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: Palette.surface,
                        borderRadius: BorderRadius.circular(Radii.lg),
                        border: Border.all(color: Palette.border),
                      ),
                      child: SelectableText(
                        s.prompt,
                        style: const TextStyle(fontSize: 13.5, height: 1.45),
                      ),
                    ),
                  ],
                ),
                Section(
                  title: 'Runs',
                  description: 'The latest 200 runs, newest first.',
                  children: c.scheduleRuns.isEmpty
                      ? const [EmptyHint('No runs yet.')]
                      : [
                          for (final run in c.scheduleRuns)
                            _ScheduleRunRow(
                              key: ValueKey('schedule-run:${run.id}'),
                              controller: c,
                              run: run,
                            ),
                        ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _InfoLine extends StatelessWidget {
  final String label, value;
  final bool warning;
  const _InfoLine({
    required this.label,
    required this.value,
    this.warning = false,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 108,
          child: Text(
            label,
            style: const TextStyle(fontSize: 13, color: Palette.fgSubtle),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: TextStyle(
              fontSize: 13.5,
              color: warning ? Palette.warning : Palette.fg,
            ),
          ),
        ),
      ],
    ),
  );
}

class _ScheduleRunRow extends StatelessWidget {
  final TaskController controller;
  final ScheduleRun run;
  const _ScheduleRunRow({
    super.key,
    required this.controller,
    required this.run,
  });
  @override
  Widget build(BuildContext context) {
    final c = controller;
    final finished = run.duration;
    final details = [
      _when(run.startedAt),
      if (finished != null && finished.inSeconds >= 0) _duration(run),
      if (run.manual) 'manual',
    ].join(' · ');
    return AppTile(
      leading: IconBadge(
        run.skipped
            ? Icons.skip_next_rounded
            : run.running
            ? Icons.sync_rounded
            : run.state == 'succeeded'
            ? Icons.check_circle_outline_rounded
            : Icons.error_outline_rounded,
        color: _stateColor(run.state),
      ),
      title: run.skipReason == null
          ? (_stateLabels[run.state] ?? run.state)
          : 'Skipped · ${run.skipReason}',
      subtitle: details,
      trailing: run.taskKey == null
          ? null
          : Text(
              run.taskKey!,
              style: const TextStyle(
                fontFamily: mono,
                fontSize: 12,
                color: Palette.primarySoft,
              ),
            ),
      onTap: run.taskKey == null
          ? null
          : () => perform(context, () => c.openScheduleRun(run)),
    );
  }
}

Future<void> showScheduleForm(
  BuildContext context,
  TaskController c, {
  Schedule? schedule,
}) => showAppSheet<void>(
  context,
  maxWidth: 600,
  builder: (_) => _ScheduleForm(controller: c, schedule: schedule),
);

class _ScheduleForm extends StatefulWidget {
  final TaskController controller;
  final Schedule? schedule;
  const _ScheduleForm({required this.controller, this.schedule});
  @override
  State<_ScheduleForm> createState() => _ScheduleFormState();
}

class _ScheduleFormState extends State<_ScheduleForm> {
  late final name = TextEditingController(text: widget.schedule?.name ?? '');
  late final cron = TextEditingController(
    text: widget.schedule?.cron ?? '0 9 * * 1-5',
  );
  late final prompt = TextEditingController(
    text: widget.schedule?.prompt ?? '',
  );
  final base = TextEditingController();
  late String agentId = widget.schedule?.agentId ?? '';
  late String timeZone = widget.schedule?.timeZone ?? 'UTC';
  late Json? repository = widget.schedule?.repository;
  late bool readOnly = widget.schedule?.readOnly ?? false;
  List<Json> repositories = [];
  String? error;
  bool loading = true, saving = false;

  @override
  void initState() {
    super.initState();
    base.text = widget.schedule?.repository?['baseBranch'] as String? ?? '';
    _loadRepositories();
  }

  Future<void> _loadRepositories() async {
    final c = widget.controller;
    if (!c.online) {
      if (mounted) setState(() => loading = false);
      return;
    }
    try {
      final value = await c.wikiRepositories();
      if (mounted) {
        setState(() {
          repositories = value;
          loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          error = e.toString();
          loading = false;
        });
      }
    }
  }

  @override
  void dispose() {
    name.dispose();
    cron.dispose();
    prompt.dispose();
    base.dispose();
    super.dispose();
  }

  Future<void> _pickAgent() async {
    final c = widget.controller;
    final selected = await showPicker<String>(
      context,
      title: 'Agent',
      selected: agentId,
      options: [
        for (final agent in c.agents.where((a) => a.enabled || a.id == agentId))
          PickerOption(
            agent.id,
            agent.name,
            detail: agent.enabled ? null : 'Disabled',
            leading: agentAvatar(c.api, agent),
          ),
      ],
    );
    if (selected != null && mounted) setState(() => agentId = selected);
  }

  Future<void> _pickTimeZone() async {
    final selected = await _showTimeZonePicker(context, timeZone);
    if (selected != null && mounted) setState(() => timeZone = selected);
  }

  Future<void> _pickRepository() async {
    final selected = await showAppSheet<({Json? repository})>(
      context,
      maxWidth: 520,
      builder: (sheet) => SheetScaffold(
        title: 'Repository',
        subtitle:
            'A Schedule without one is global: its Agent works on the boards.',
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AppTile(
              leading: const IconBadge(
                Icons.public_rounded,
                color: Palette.info,
              ),
              title: 'No repository (global)',
              selected: repository == null,
              onTap: () => Navigator.pop(sheet, (repository: null)),
            ),
            for (final r in repositories)
              AppTile(
                title: '${r['owner']}/${r['name']}',
                subtitle: r['defaultBranch'] as String?,
                selected:
                    repository?['connectionId'] == r['connectionId'] &&
                    repository?['providerRepoId'] == r['providerRepoId'],
                onTap: () => Navigator.pop(sheet, (repository: r)),
              ),
          ],
        ),
      ),
    );
    if (selected != null && mounted) {
      setState(() {
        repository = selected.repository;
        base.text =
            repository?['baseBranch'] as String? ??
            repository?['defaultBranch'] as String? ??
            '';
      });
    }
  }

  bool get _repositoryChanged {
    final existing = widget.schedule?.repository;
    if (widget.schedule == null) return true;
    final same =
        repository?['connectionId'] == existing?['connectionId'] &&
        repository?['providerRepoId'] == existing?['providerRepoId'];
    final sameBase =
        base.text.trim() == ((existing?['baseBranch'] as String?) ?? '');
    return !(same && sameBase);
  }

  Future<void> _save() async {
    setState(() {
      saving = true;
      error = null;
    });
    try {
      final body = <String, dynamic>{
        'name': name.text.trim(),
        'cron': cron.text.trim(),
        'timeZone': timeZone,
        'prompt': prompt.text.trim(),
        'readOnly': readOnly,
        // A disabled Agent stays valid while it isn't being changed.
        if (widget.schedule == null || widget.schedule!.agentId != agentId)
          'agentId': agentId,
        if (_repositoryChanged)
          'repository': repository == null
              ? null
              : {
                  'connectionId': repository!['connectionId'],
                  'providerRepoId': repository!['providerRepoId'],
                  if (base.text.trim().isNotEmpty)
                    'baseBranch': base.text.trim(),
                },
      };
      await widget.controller.saveSchedule(body, existing: widget.schedule);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          error = e.toString();
          saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, agent = c.agents.byId(agentId);
    final cronText = cron.text.trim(), validCron = parseCron(cronText) != null;
    final canSave =
        !saving &&
        name.text.trim().isNotEmpty &&
        agentId.isNotEmpty &&
        cronText.isNotEmpty &&
        validCron &&
        prompt.text.trim().isNotEmpty;
    return SheetScaffold(
      title: widget.schedule == null ? 'New schedule' : 'Edit schedule',
      subtitle: 'The Agent runs on its own, at times you choose.',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Notice.error(error!),
            ),
          LabeledField(
            label: 'Name',
            child: TextField(
              key: const Key('schedule-name'),
              controller: name,
              maxLength: 100,
              enabled: !saving,
              decoration: const InputDecoration(counterText: ''),
              onChanged: (_) => setState(() {}),
            ),
          ),
          LabeledField(
            label: 'Agent',
            child: SelectField(
              key: const Key('schedule-agent'),
              leading: agent == null
                  ? null
                  : agentAvatar(c.api, agent, size: 26),
              label: agent?.name ?? 'Choose an Agent',
              placeholder: agent == null,
              onTap: saving ? null : _pickAgent,
            ),
          ),
          LabeledField(
            label: 'Cron expression',
            hint: validCron ? describeCron(cronText) : 'not valid',
            description:
                'Five fields: minute, hour, day of month, month, day of week.',
            child: TextField(
              key: const Key('schedule-cron'),
              controller: cron,
              enabled: !saving,
              style: const TextStyle(fontFamily: mono),
              decoration: const InputDecoration(
                hintText: '0 9 * * 1-5',
                counterText: '',
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
          LabeledField(
            label: 'Time zone',
            description: 'The cron expression is read in this zone.',
            child: SelectField(
              key: const Key('schedule-time-zone'),
              leading: const Icon(
                Icons.public_rounded,
                size: 18,
                color: Palette.fgMuted,
              ),
              label: timeZone,
              onTap: saving ? null : _pickTimeZone,
            ),
          ),
          LabeledField(
            label: 'Prompt',
            description: 'Posted as the first message of every run.',
            child: TextField(
              key: const Key('schedule-prompt'),
              controller: prompt,
              enabled: !saving,
              minLines: 4,
              maxLines: 10,
              maxLength: 50000,
              decoration: const InputDecoration(counterText: ''),
              onChanged: (_) => setState(() {}),
            ),
          ),
          LabeledField(
            label: 'Repository',
            description: loading
                ? 'Loading repositories…'
                : repositories.isEmpty
                ? 'No Git Connection available: the Schedule stays global.'
                : 'Leave empty for a global Schedule: its Agent works on the boards.',
            child: SelectField(
              key: const Key('schedule-repository'),
              label: repository == null
                  ? 'No repository (global)'
                  : '${repository!['owner']}/${repository!['name']}',
              placeholder: repository == null,
              onTap: saving || (loading && widget.schedule == null)
                  ? null
                  : _pickRepository,
            ),
          ),
          if (repository != null)
            LabeledField(
              label: 'Base branch',
              child: TextField(
                key: const Key('schedule-base-branch'),
                controller: base,
                enabled: !saving,
                onChanged: (_) => setState(() {}),
              ),
            ),
          Pressable(
            key: const Key('schedule-read-only'),
            onTap: saving ? null : () => setState(() => readOnly = !readOnly),
            semanticLabel: 'Read-only',
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              children: [
                Switch.adaptive(
                  value: readOnly,
                  activeTrackColor: Palette.primary,
                  onChanged: saving
                      ? null
                      : (value) => setState(() => readOnly = value),
                ),
                const SizedBox(width: 10),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Read-only', style: TextStyle(fontSize: 14.5)),
                      Text(
                        'The Agent can fetch the repository but every push is refused.',
                        style: TextStyle(fontSize: 12, color: Palette.fgSubtle),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      actions: [
        AppButton(
          label: 'Cancel',
          tone: Tone.secondary,
          onPressed: saving ? null : () => Navigator.pop(context),
        ),
        AppButton(
          label: widget.schedule == null ? 'Create schedule' : 'Save schedule',
          busy: saving,
          onPressed: canSave ? _save : null,
        ),
      ],
    );
  }
}

/// A searchable IANA time zone picker. The backend validates the value.
Future<String?> _showTimeZonePicker(BuildContext context, String selected) =>
    showAppSheet<String>(
      context,
      maxWidth: 480,
      builder: (_) => _TimeZonePicker(selected: selected),
    );

class _TimeZonePicker extends StatefulWidget {
  final String selected;
  const _TimeZonePicker({required this.selected});
  @override
  State<_TimeZonePicker> createState() => _TimeZonePickerState();
}

class _TimeZonePickerState extends State<_TimeZonePicker> {
  final _search = TextEditingController();
  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final query = _search.text.trim().toLowerCase();
    final zones = query.isEmpty
        ? ianaTimeZones
        : ianaTimeZones.where((z) => z.toLowerCase().contains(query)).toList();
    return SheetScaffold(
      title: 'Time zone',
      scroll: false,
      body: SizedBox(
        height: 420,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 4, 22, 10),
              child: TextField(
                key: const Key('time-zone-search'),
                controller: _search,
                autofocus: true,
                decoration: const InputDecoration(
                  hintText: 'Search, e.g. Europe/Rome',
                  prefixIcon: Icon(Icons.search_rounded, size: 20),
                ),
                onChanged: (_) => setState(() {}),
              ),
            ),
            Expanded(
              child: zones.isEmpty
                  ? const Center(
                      child: Text(
                        'No time zone matches.',
                        style: TextStyle(color: Palette.fgSubtle),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                      itemCount: zones.length,
                      itemBuilder: (context, index) {
                        final zone = zones[index];
                        return Pressable(
                          onTap: () => Navigator.pop(context, zone),
                          color: zone == widget.selected
                              ? Palette.primary.withValues(alpha: .12)
                              : Colors.transparent,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 11,
                          ),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  zone,
                                  style: const TextStyle(fontSize: 14),
                                ),
                              ),
                              if (zone == widget.selected)
                                const Icon(
                                  Icons.check_rounded,
                                  size: 18,
                                  color: Palette.primarySoft,
                                ),
                            ],
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
