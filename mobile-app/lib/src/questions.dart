import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';

import 'controller.dart';
import 'models.dart';
import 'task_forms.dart' show openLink;
import 'ui/markdown.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

/// "Other" is at most this long, as the API checks.
const _otherLimit = 2000;

/// An Agent's Question, in place of its Markdown body: one block per item and
/// a single "Send answer", or the answer read-only once someone answered.
class QuestionCard extends StatefulWidget {
  final String commentId;
  final Question question;
  final TaskController controller;
  const QuestionCard({
    super.key,
    required this.commentId,
    required this.question,
    required this.controller,
  });
  @override
  State<QuestionCard> createState() => _QuestionCardState();
}

class _QuestionCardState extends State<QuestionCard> {
  late final _choices = [
    for (final item in widget.question.items) _Choice(item),
  ];
  bool _busy = false;

  @override
  void dispose() {
    for (final c in _choices) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _send() async {
    setState(() => _busy = true);
    await widget.controller.answerQuestion(widget.commentId, [
      for (final c in _choices) c.answer,
    ]);
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final q = widget.question, open = q.open;
    final answer = q.answer;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, item) in q.items.indexed)
          _ItemView(
            key: ValueKey('question-item:${widget.commentId}:$i'),
            fieldKey: 'question-other:${widget.commentId}:$i',
            item: item,
            choice: _choices[i],
            answer: open ? null : answer?.elementAtOrNull(i),
            onChanged: open && !_busy ? () => setState(() {}) : null,
            first: i == 0,
          ),
        const SizedBox(height: 12),
        if (open)
          Align(
            alignment: Alignment.centerLeft,
            child: AppButton(
              label: 'Send answer',
              icon: Icons.send_rounded,
              compact: true,
              busy: _busy,
              onPressed: _choices.every((c) => c.valid) ? _send : null,
            ),
          )
        else
          _Footnote(
            icon: Icons.check_circle_outline_rounded,
            color: Palette.success,
            text: [
              'Answered by ${q.answeredBy?.displayName ?? 'someone'}',
              if (q.answeredAt != null) dayTime(q.answeredAt!),
            ].join(' · '),
          ),
      ],
    );
  }
}

/// An Agent's Survey: the User's own answer (editable while open), the
/// answers so far with names, who is still expected, and "Send now".
class SurveyCard extends StatefulWidget {
  final String commentId;
  final Survey survey;
  final TaskController controller;
  const SurveyCard({
    super.key,
    required this.commentId,
    required this.survey,
    required this.controller,
  });
  @override
  State<SurveyCard> createState() => _SurveyCardState();
}

class _SurveyCardState extends State<SurveyCard> {
  late final _choices = [for (final item in widget.survey.items) _Choice(item)];

  /// The own response the choices were loaded from, to pick up a change made
  /// on another device without discarding edits in progress.
  String? _loaded;
  bool _saving = false, _closing = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(SurveyCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    _load();
  }

  void _load() {
    final own = widget.survey.responseOf(widget.controller.user?.id);
    if (own == null || own.updatedAt == _loaded) return;
    _loaded = own.updatedAt;
    for (final (i, c) in _choices.indexed) {
      c.load(own.answers.elementAtOrNull(i));
    }
  }

  @override
  void dispose() {
    for (final c in _choices) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final saved = await widget.controller.respondToSurvey(widget.commentId, [
      for (final c in _choices) c.answer,
    ]);
    if (!mounted) return;
    setState(() => _saving = false);
    if (saved) toast(context, 'Answer saved', error: false);
  }

  Future<void> _close() async {
    setState(() => _closing = true);
    await widget.controller.closeSurvey(widget.commentId);
    if (mounted) setState(() => _closing = false);
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.survey, open = s.open, busy = _saving || _closing;
    final own = s.responseOf(widget.controller.user?.id);
    final answered = {for (final r in s.responses) r.user.id};
    final expected = s.expectedRespondents;
    final missing = expected.where((a) => !answered.contains(a.id)).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, item) in s.items.indexed)
          _ItemView(
            key: ValueKey('survey-item:${widget.commentId}:$i'),
            fieldKey: 'survey-other:${widget.commentId}:$i',
            item: item,
            choice: _choices[i],
            answer: open ? null : own?.answers.elementAtOrNull(i),
            responses: s.responses,
            index: i,
            onChanged: open && !busy ? () => setState(() {}) : null,
            first: i == 0,
          ),
        const SizedBox(height: 12),
        _Footnote(
          icon: Icons.groups_2_outlined,
          text: [
            '${expected.length - missing.length}/${expected.length} expected answered',
            if (open && missing.isNotEmpty)
              'waiting for ${missing.map((a) => a.displayName).join(', ')}',
            if (!open && missing.isNotEmpty)
              'no answer from ${missing.map((a) => a.displayName).join(', ')}',
          ].join(' · '),
        ),
        if (open) ...[
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              AppButton(
                label: own == null ? 'Save answer' : 'Update answer',
                icon: Icons.how_to_vote_outlined,
                compact: true,
                busy: _saving,
                onPressed: !_closing && _choices.every((c) => c.valid)
                    ? _save
                    : null,
              ),
              AppButton(
                label: 'Send now',
                icon: Icons.send_rounded,
                tone: Tone.secondary,
                compact: true,
                busy: _closing,
                onPressed: _saving ? null : _close,
              ),
            ],
          ),
        ] else ...[
          const SizedBox(height: 6),
          _Footnote(
            icon: Icons.lock_outline_rounded,
            color: Palette.success,
            text: [
              s.closedBy == null
                  ? 'Everyone answered'
                  : 'Closed by ${s.closedBy!.displayName}',
              if (s.closedAt != null) dayTime(s.closedAt!),
            ].join(' · '),
          ),
        ],
      ],
    );
  }
}

/// What the User picked for one item while editing.
class _Choice {
  final QuestionItem item;
  final selected = <String>{};
  bool other = false;
  final text = TextEditingController();
  _Choice(this.item);

  void load(QuestionAnswer? answer) {
    selected
      ..clear()
      ..addAll(answer?.selected ?? const []);
    other = answer?.other != null;
    text.text = answer?.other ?? '';
  }

  void toggle(String label) {
    if (item.multiSelect) {
      if (!selected.remove(label)) selected.add(label);
    } else {
      selected
        ..clear()
        ..add(label);
      other = false;
    }
  }

  void toggleOther() {
    if (item.multiSelect) {
      other = !other;
    } else {
      other = true;
      selected.clear();
    }
  }

  String? get _otherText =>
      other && text.text.trim().isNotEmpty ? text.text.trim() : null;

  /// One choice for a single-choice item, at least one for a multiple one.
  bool get valid => item.multiSelect
      ? selected.isNotEmpty || _otherText != null
      : (selected.length == 1 && !other) ||
            (selected.isEmpty && _otherText != null);

  QuestionAnswer get answer => QuestionAnswer([
    for (final o in item.options)
      if (selected.contains(o.label)) o.label,
  ], _otherText);

  void dispose() => text.dispose();
}

/// One item: its header, question, options and "Other". Editable through
/// [choice] when [onChanged] is set, otherwise it shows [answer]; with
/// [responses] each option also shows who chose it.
class _ItemView extends StatelessWidget {
  final QuestionItem item;
  final _Choice choice;
  final QuestionAnswer? answer;
  final List<SurveyResponse>? responses;
  final int index;
  final VoidCallback? onChanged;
  final String fieldKey;
  final bool first;
  const _ItemView({
    super.key,
    required this.item,
    required this.choice,
    required this.fieldKey,
    this.answer,
    this.responses,
    this.index = 0,
    this.onChanged,
    this.first = false,
  });

  @override
  Widget build(BuildContext context) {
    final editing = answer == null;
    bool picked(String label) => editing
        ? choice.selected.contains(label)
        : answer!.selected.contains(label);
    final other = editing ? choice.other : answer!.other != null;
    List<String> chose(String label) => [
      for (final r in responses ?? const <SurveyResponse>[])
        if (r.answers.elementAtOrNull(index)?.selected.contains(label) == true)
          r.user.displayName,
    ];
    final others = [
      for (final r in responses ?? const <SurveyResponse>[])
        if (r.answers.elementAtOrNull(index)?.other case final text?)
          (r.user.displayName, text),
    ];
    return Padding(
      padding: EdgeInsets.only(top: first ? 0 : 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Flexible(
                child: Pill(label: item.header, color: Palette.agent),
              ),
              if (onChanged != null) ...[
                const SizedBox(width: 8),
                Text(
                  item.multiSelect ? 'Choose any' : 'Choose one',
                  style: const TextStyle(fontSize: 11, color: Palette.fgSubtle),
                ),
              ],
            ],
          ),
          const SizedBox(height: 6),
          Md(item.question, onLink: openLink),
          const SizedBox(height: 8),
          for (final option in item.options)
            _OptionRow(
              label: option.label,
              description: option.description,
              multi: item.multiSelect,
              selected: picked(option.label),
              names: responses == null ? null : chose(option.label),
              onTap: onChanged == null
                  ? null
                  : () {
                      choice.toggle(option.label);
                      onChanged!();
                    },
            ),
          _OptionRow(
            label: 'Other',
            description: editing ? '' : answer!.other ?? '',
            multi: item.multiSelect,
            selected: other,
            names: responses == null || others.isEmpty
                ? null
                : [for (final (name, text) in others) '$name: “$text”'],
            onTap: onChanged == null
                ? null
                : () {
                    choice.toggleOther();
                    onChanged!();
                  },
          ),
          if (editing && other && onChanged != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: TextField(
                key: ValueKey(fieldKey),
                controller: choice.text,
                minLines: 1,
                maxLines: 4,
                inputFormatters: [
                  LengthLimitingTextInputFormatter(_otherLimit),
                ],
                decoration: const InputDecoration(hintText: 'Your answer'),
                onChanged: (_) => onChanged!(),
              ),
            ),
        ],
      ),
    );
  }
}

/// A selectable option: a radio for single choice, a check box for multiple
/// choice. [names] lists who chose it, on a Survey.
class _OptionRow extends StatelessWidget {
  final String label, description;
  final bool multi, selected;
  final List<String>? names;
  final VoidCallback? onTap;
  const _OptionRow({
    required this.label,
    required this.description,
    required this.multi,
    required this.selected,
    this.names,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final icon = multi
        ? selected
              ? Icons.check_box_rounded
              : Icons.check_box_outline_blank_rounded
        : selected
        ? Icons.radio_button_checked_rounded
        : Icons.radio_button_unchecked_rounded;
    final count = names?.length ?? 0;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Semantics(
        selected: selected,
        child: Pressable(
          onTap: onTap,
          pressedScale: .99,
          color: selected
              ? Palette.primary.withValues(alpha: .12)
              : Palette.surface,
          border: Border.all(
            color: selected
                ? Palette.primary.withValues(alpha: .55)
                : Palette.border,
          ),
          borderRadius: BorderRadius.circular(Radii.sm + 2),
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: Icon(
                  icon,
                  size: 18,
                  color: selected ? Palette.primarySoft : Palette.fgSubtle,
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: selected ? Palette.fg : Palette.fgMuted,
                      ),
                    ),
                    if (description.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          description,
                          style: const TextStyle(
                            fontSize: 12.5,
                            height: 1.35,
                            color: Palette.fgSubtle,
                          ),
                        ),
                      ),
                    if (names != null && names!.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          names!.join(', '),
                          style: const TextStyle(
                            fontSize: 12,
                            height: 1.35,
                            color: Palette.info,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (names != null && label != 'Other') ...[
                const SizedBox(width: 8),
                Text(
                  '$count',
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: count > 0 ? Palette.fg : Palette.fgSubtle,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _Footnote extends StatelessWidget {
  final IconData icon;
  final String text;
  final Color color;
  const _Footnote({
    required this.icon,
    required this.text,
    this.color = Palette.fgSubtle,
  });
  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.only(top: 1),
        child: Icon(icon, size: 14, color: color),
      ),
      const SizedBox(width: 6),
      Expanded(
        child: Text(
          text,
          style: const TextStyle(fontSize: 12, color: Palette.fgMuted),
        ),
      ),
    ],
  );
}

/// The time, with the day when it isn't today.
String dayTime(DateTime date) {
  final d = date.toLocal(), now = DateTime.now();
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', //
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  final time =
      '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  if (d.year == now.year && d.month == now.month && d.day == now.day) {
    return time;
  }
  return '${d.day} ${months[d.month - 1]}${d.year == now.year ? '' : ' ${d.year}'} $time';
}
