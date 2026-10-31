import 'package:material_ui/material_ui.dart';

import 'controller.dart';
import 'models.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

/// A scheduled message is due between one minute and this many days from now.
const scheduleMaxDays = 366;

const _months = [
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

/// A time in the device's time zone: "Oct 31, 14:30", with the year when it
/// isn't the current one.
String formatDue(DateTime value, [DateTime? now]) {
  final d = value.toLocal(), year = (now ?? DateTime.now()).year;
  final time =
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  return '${_months[d.month - 1]} ${d.day}${d.year == year ? '' : ', ${d.year}'}, $time';
}

/// Why [due] can't be scheduled, or null when it can.
String? scheduleProblem(DateTime due, [DateTime? now]) {
  final from = now ?? DateTime.now();
  if (due.isBefore(from.add(const Duration(minutes: 1)))) {
    return 'Pick a time at least one minute from now.';
  }
  if (due.isAfter(from.add(const Duration(days: scheduleMaxDays)))) {
    return 'Pick a time within $scheduleMaxDays days.';
  }
  return null;
}

/// Asks for a date, then a time, in the device's time zone. Null when
/// dismissed or when the time is out of range (a toast says why).
Future<DateTime?> pickScheduleTime(
  BuildContext context, {
  DateTime? initial,
}) async {
  final now = DateTime.now();
  final last = now.add(const Duration(days: scheduleMaxDays));
  final start = initial?.toLocal() ?? now.add(const Duration(hours: 1));
  final date = await showDatePicker(
    context: context,
    initialDate: start.isBefore(now)
        ? now
        : (start.isAfter(last) ? last : start),
    firstDate: DateTime(now.year, now.month, now.day),
    lastDate: last,
    helpText: 'Send on',
  );
  if (date == null || !context.mounted) return null;
  final time = await showTimePicker(
    context: context,
    initialTime: TimeOfDay.fromDateTime(start),
    helpText: 'Send at',
  );
  if (time == null || !context.mounted) return null;
  final due = DateTime(date.year, date.month, date.day, time.hour, time.minute);
  final problem = scheduleProblem(due);
  if (problem != null) {
    toast(context, problem);
    return null;
  }
  return due;
}

String _excerpt(String body) {
  final text = body.trim().replaceAll(RegExp(r'\s+'), ' ');
  return text.length > 140 ? '${text.substring(0, 140)}…' : text;
}

/// The Task's Scheduled Messages above the composer: the pending ones with
/// Edit, Cancel and Send now, and a collapsed history of the finished ones.
/// Hidden when there are none.
class ScheduledSection extends StatefulWidget {
  final TaskController controller;
  const ScheduledSection({super.key, required this.controller});
  @override
  State<ScheduledSection> createState() => _ScheduledSectionState();
}

class _ScheduledSectionState extends State<ScheduledSection> {
  bool _history = false;
  String? _busy;

  Future<void> _run(ScheduledMessage m, Future<bool> Function() action) async {
    setState(() => _busy = m.id);
    await action();
    if (mounted) setState(() => _busy = null);
  }

  Future<void> _edit(ScheduledMessage m) async {
    final c = widget.controller;
    final text = TextEditingController(text: m.body);
    var due = m.dueAt.toLocal();
    final result = await showAppSheet<({String body, DateTime due})>(
      context,
      builder: (sheet) => StatefulBuilder(
        builder: (context, setSheet) => SheetScaffold(
          title: m.isLimitResume
              ? 'Edit resume time'
              : 'Edit scheduled message',
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (!m.isLimitResume)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: TextField(
                    key: const Key('scheduled-edit-text'),
                    controller: text,
                    autofocus: true,
                    minLines: 3,
                    maxLines: 10,
                  ),
                ),
              Align(
                alignment: Alignment.centerLeft,
                child: AppButton(
                  key: const Key('scheduled-edit-time'),
                  label: formatDue(due),
                  icon: Icons.schedule_rounded,
                  tone: Tone.secondary,
                  onPressed: () async {
                    final picked = await pickScheduleTime(sheet, initial: due);
                    if (picked != null) setSheet(() => due = picked);
                  },
                ),
              ),
            ],
          ),
          actions: [
            AppButton(
              label: 'Cancel',
              tone: Tone.secondary,
              onPressed: () => Navigator.pop(sheet),
            ),
            AppButton(
              label: 'Save',
              onPressed: () {
                final problem = scheduleProblem(due);
                if (problem != null) {
                  toast(sheet, problem);
                  return;
                }
                Navigator.pop(sheet, (body: text.text, due: due));
              },
            ),
          ],
        ),
      ),
    );
    text.dispose();
    if (result == null || !mounted) return;
    final bodyChanged = !m.isLimitResume && result.body != m.body;
    final dueChanged = result.due.toUtc() != m.dueAt.toUtc();
    if (!bodyChanged && !dueChanged) return;
    await _run(
      m,
      () => c.editScheduled(
        m.id,
        body: bodyChanged ? result.body : null,
        dueAt: dueChanged ? result.due : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final pending = c.scheduledMessages.where((m) => m.pending).toList();
    final finished = c.scheduledMessages.where((m) => !m.pending).toList();
    if (pending.isEmpty && finished.isEmpty) return const SizedBox.shrink();
    return Container(
      key: const Key('scheduled-section'),
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: Palette.muted,
        borderRadius: BorderRadius.circular(Radii.xl),
        border: Border.all(color: Palette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(
                Icons.schedule_send_outlined,
                size: 15,
                color: Palette.fgSubtle,
              ),
              const SizedBox(width: 6),
              const Text(
                'Scheduled',
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: Palette.fgMuted,
                ),
              ),
              const Spacer(),
              if (finished.isNotEmpty)
                Pressable(
                  key: const Key('scheduled-history-toggle'),
                  onTap: () => setState(() => _history = !_history),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 2,
                  ),
                  child: Text(
                    _history ? 'Hide history' : 'History (${finished.length})',
                    style: const TextStyle(
                      fontSize: 12,
                      color: Palette.fgSubtle,
                    ),
                  ),
                ),
            ],
          ),
          for (final m in pending)
            _ScheduledRow(
              key: ValueKey('scheduled:${m.id}'),
              message: m,
              controller: c,
              busy: _busy == m.id,
              onEdit: () => _edit(m),
              onCancel: () => _run(m, () => c.cancelScheduled(m.id)),
              onSendNow: () => _run(m, () => c.sendScheduledNow(m.id)),
            ),
          if (_history)
            for (final m in finished)
              _ScheduledRow(
                key: ValueKey('scheduled:${m.id}'),
                message: m,
                controller: c,
              ),
        ],
      ),
    );
  }
}

class _ScheduledRow extends StatelessWidget {
  final ScheduledMessage message;
  final TaskController controller;
  final bool busy;
  final VoidCallback? onEdit, onCancel, onSendNow;
  const _ScheduledRow({
    super.key,
    required this.message,
    required this.controller,
    this.busy = false,
    this.onEdit,
    this.onCancel,
    this.onSendNow,
  });

  /// What happened to a finished message.
  String get _outcome => message.state == 'sent'
      ? 'Sent'
      : 'Cancelled${message.cancelReason == null ? '' : ' · ${message.cancelReason}'}';

  @override
  Widget build(BuildContext context) {
    final m = message, text = _excerpt(m.body);
    final actions = m.pending && controller.online && !busy;
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 2,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                m.isLimitResume
                    ? 'Resume after usage limit'
                    : m.author.displayName,
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
              Text(
                formatDue(m.dueAt),
                style: const TextStyle(fontSize: 12, color: Palette.fgMuted),
              ),
              if (m.internal)
                const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.lock_rounded, size: 11, color: Palette.slate),
                    SizedBox(width: 3),
                    Text(
                      'Internal chat',
                      style: TextStyle(fontSize: 11, color: Palette.slate),
                    ),
                  ],
                ),
              if (!m.pending)
                Text(
                  _outcome,
                  style: const TextStyle(fontSize: 12, color: Palette.fgSubtle),
                ),
            ],
          ),
          if (text.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                text,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13.5, color: Palette.fgMuted),
              ),
            ),
          if (m.attachments.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Row(
                children: [
                  const Icon(
                    Icons.attach_file_rounded,
                    size: 13,
                    color: Palette.fgSubtle,
                  ),
                  const SizedBox(width: 3),
                  Expanded(
                    child: Text(
                      m.attachments
                          .map((a) => a['filename'] as String? ?? 'file')
                          .join(', '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 12,
                        color: Palette.fgSubtle,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (m.pending)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Wrap(
                spacing: 8,
                runSpacing: 6,
                children: [
                  AppButton(
                    key: Key('scheduled-edit:${m.id}'),
                    label: 'Edit',
                    icon: Icons.edit_outlined,
                    tone: Tone.secondary,
                    compact: true,
                    onPressed: actions ? onEdit : null,
                  ),
                  AppButton(
                    key: Key('scheduled-cancel:${m.id}'),
                    label: 'Cancel',
                    icon: Icons.close_rounded,
                    tone: Tone.secondary,
                    compact: true,
                    onPressed: actions ? onCancel : null,
                  ),
                  AppButton(
                    key: Key('scheduled-send:${m.id}'),
                    label: 'Send now',
                    icon: Icons.send_rounded,
                    compact: true,
                    busy: busy,
                    onPressed: actions ? onSendNow : null,
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// The System Comment of a usage limit: the reset time with "Schedule resume"
/// and "No" while open, otherwise how it was answered.
class LimitResumeCard extends StatefulWidget {
  final String commentId;
  final LimitResume offer;
  final TaskController controller;
  const LimitResumeCard({
    super.key,
    required this.commentId,
    required this.offer,
    required this.controller,
  });
  @override
  State<LimitResumeCard> createState() => _LimitResumeCardState();
}

class _LimitResumeCardState extends State<LimitResumeCard> {
  bool? _busy;

  Future<void> _answer(bool schedule) async {
    setState(() => _busy = schedule);
    await widget.controller.answerLimitResume(widget.commentId, schedule);
    if (mounted) setState(() => _busy = null);
  }

  String get _outcome {
    final o = widget.offer, who = o.decidedBy?.displayName;
    return switch (o.state) {
      'scheduled' =>
        who == null
            ? 'Resume scheduled automatically'
            : 'Resume scheduled by $who',
      'declined' => who == null ? 'Not resuming' : 'Declined by $who',
      _ => 'No longer needed',
    };
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.offer, online = widget.controller.online;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(
              Icons.hourglass_bottom_rounded,
              size: 15,
              color: Palette.warning,
            ),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                'Usage limit resets ${formatDue(o.resetsAt)}',
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (o.open)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              AppButton(
                key: Key('limit-resume-yes:${widget.commentId}'),
                label: 'Schedule resume',
                icon: Icons.schedule_rounded,
                compact: true,
                busy: _busy == true,
                onPressed: online && _busy == null ? () => _answer(true) : null,
              ),
              AppButton(
                key: Key('limit-resume-no:${widget.commentId}'),
                label: 'No',
                tone: Tone.secondary,
                compact: true,
                busy: _busy == false,
                onPressed: online && _busy == null
                    ? () => _answer(false)
                    : null,
              ),
            ],
          )
        else
          Text(
            key: Key('limit-resume-outcome:${widget.commentId}'),
            _outcome,
            style: const TextStyle(fontSize: 12.5, color: Palette.fgMuted),
          ),
      ],
    );
  }
}
