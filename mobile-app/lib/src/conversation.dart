import 'dart:async';
import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:open_filex/open_filex.dart';
import 'app.dart';
import 'controller.dart';
import 'models.dart';
import 'task_forms.dart';
import 'ui/markdown.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';
import 'ui/skill_suggestions.dart';

class Conversation extends StatefulWidget {
  final TaskController controller;
  final VoidCallback? onBack;
  final bool showDetailsAction;
  const Conversation({
    super.key,
    required this.controller,
    this.onBack,
    this.showDetailsAction = false,
  });
  @override
  State<Conversation> createState() => _ConversationState();
}

class _ConversationState extends State<Conversation> {
  final _scroll = ScrollController();
  bool _atBottom = true, _loadingOlder = false, _readPending = false;
  String? _readId;
  String _stamp = '';
  @override
  void initState() {
    super.initState();
    _scroll.addListener(_scrolled);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _scrolled() {
    final bottom = _scroll.position.pixels < 80;
    if (_atBottom != bottom) setState(() => _atBottom = bottom);
    if (bottom) _markReached();
  }

  void _markReached() {
    final c = widget.controller;
    if (!_atBottom ||
        _readPending ||
        !c.online ||
        !c.appVisible ||
        c.timeline.isEmpty ||
        c.timeline.last.id == _readId) {
      return;
    }
    final id = c.timeline.last.id;
    _readPending = true;
    unawaited(
      c
          .reachedLatest()
          .then((_) {
            _readId = id;
          })
          .catchError((Object _) {})
          .whenComplete(() {
            _readPending = false;
          }),
    );
  }

  void _afterContent() {
    final c = widget.controller;
    final stamp =
        '${c.timeline.isEmpty ? '' : c.timeline.last.id}:${c.liveText.values.join().length}:${c.timeline.length}';
    if (stamp == _stamp) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _markReached();
      });
      return;
    }
    final previous = _stamp;
    _stamp = stamp;
    final oldExtent = _scroll.hasClients
        ? _scroll.position.maxScrollExtent
        : 0.0;
    final oldPixels = _scroll.hasClients ? _scroll.position.pixels : 0.0;
    final preserve =
        !_atBottom &&
        !_loadingOlder &&
        previous.split(':').first != stamp.split(':').first;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      if (_atBottom) {
        _scroll.jumpTo(0);
      } else if (preserve) {
        _scroll.jumpTo(
          (oldPixels + _scroll.position.maxScrollExtent - oldExtent).clamp(
            0,
            _scroll.position.maxScrollExtent,
          ),
        );
      }
      _markReached();
    });
  }

  Future<void> _loadOlder() async {
    setState(() => _loadingOlder = true);
    await perform(context, widget.controller.loadOlder);
    if (mounted) setState(() => _loadingOlder = false);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, t = widget.controller.task;
    // The outgoing page of a transition may outlive the selected Task.
    if (t == null) return const SizedBox.shrink();
    _afterContent();
    final live =
        c.liveThinking.isNotEmpty ||
        c.liveText.isNotEmpty ||
        c.liveStatus.isNotEmpty;
    return Column(
      children: [
        _Header(
          controller: c,
          task: t,
          onBack: widget.onBack,
          showDetailsAction: widget.showDetailsAction,
        ),
        if (c.assignmentRetryId != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
            child: Notice(
              icon: Icons.person_add_alt_rounded,
              message: 'Task created. Agent assignment needs retry.',
              actionLabel: 'Retry assignment',
              onAction: c.online
                  ? () => perform(context, c.retryAssignment)
                  : null,
            ),
          ),
        Expanded(
          child: Stack(
            children: [
              Positioned.fill(
                child: c.timeline.isEmpty && !live
                    ? EmptyState(
                        icon: Icons.chat_bubble_outline_rounded,
                        title: 'Start the conversation with a Comment.',
                        message: t.agentId == null
                            ? 'Comments here are visible to everyone on the Task.'
                            : 'Your first Comment starts the Agent.',
                      )
                    : ListView.builder(
                        key: const Key('timeline'),
                        controller: _scroll,
                        reverse: true,
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
                        itemCount: c.timeline.length + 2,
                        itemBuilder: (context, index) {
                          if (index == 0) return _LiveTail(controller: c);
                          if (index == c.timeline.length + 1) {
                            return c.nextCursor == null
                                ? const SizedBox(height: 12)
                                : Center(
                                    child: Padding(
                                      padding: const EdgeInsets.only(
                                        bottom: 12,
                                      ),
                                      child: AppButton(
                                        label: 'Load older entries',
                                        icon: Icons.history_rounded,
                                        tone: Tone.secondary,
                                        compact: true,
                                        busy: _loadingOlder,
                                        onPressed: c.online ? _loadOlder : null,
                                      ),
                                    ),
                                  );
                          }
                          final i = c.timeline.length - index;
                          final entry = c.timeline[i];
                          final previous = i > 0 ? c.timeline[i - 1] : null;
                          final newDay =
                              previous == null ||
                              !_sameDay(previous.createdAt, entry.createdAt);
                          return Column(
                            key: ValueKey(entry.id),
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              if (newDay) _DaySeparator(date: entry.createdAt),
                              TimelineTile(
                                entry: entry,
                                controller: c,
                                grouped: !newDay && _continues(previous, entry),
                              ),
                            ],
                          );
                        },
                      ),
              ),
              Positioned(
                bottom: 14,
                right: 16,
                child: AnimatedSlide(
                  offset: _atBottom ? const Offset(0, .4) : Offset.zero,
                  duration: const Duration(milliseconds: 200),
                  curve: Curves.easeOutCubic,
                  child: AnimatedOpacity(
                    opacity: _atBottom ? 0 : 1,
                    duration: const Duration(milliseconds: 200),
                    child: IgnorePointer(
                      ignoring: _atBottom,
                      child: _atBottom
                          ? const SizedBox.shrink()
                          : Pressable(
                              key: const Key('jump-latest'),
                              onTap: () => _scroll.animateTo(
                                0,
                                duration: const Duration(milliseconds: 260),
                                curve: Curves.easeOutCubic,
                              ),
                              color: Palette.raised,
                              border: Border.all(color: Palette.borderStrong),
                              borderRadius: BorderRadius.circular(99),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 14,
                                vertical: 9,
                              ),
                              child: const Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(
                                    Icons.arrow_downward_rounded,
                                    size: 16,
                                    color: Palette.fg,
                                  ),
                                  SizedBox(width: 6),
                                  Text(
                                    'Jump to latest',
                                    style: TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        Composer(key: ValueKey('composer:${t.id}'), controller: c),
      ],
    );
  }

  static bool _sameDay(DateTime a, DateTime b) {
    final x = a.toLocal(), y = b.toLocal();
    return x.year == y.year && x.month == y.month && x.day == y.day;
  }

  /// Consecutive Comments by the same author within a few minutes share a header.
  static bool _continues(TimelineEntry? previous, TimelineEntry entry) =>
      previous != null &&
      previous.type == 'comment' &&
      entry.type == 'comment' &&
      previous.content['kind'] == entry.content['kind'] &&
      previous.authorId == entry.authorId &&
      previous.internal == entry.internal &&
      entry.createdAt.difference(previous.createdAt).inMinutes < 5;
}

class _Header extends StatelessWidget {
  final TaskController controller;
  final Task task;
  final VoidCallback? onBack;
  final bool showDetailsAction;
  const _Header({
    required this.controller,
    required this.task,
    this.onBack,
    required this.showDetailsAction,
  });
  @override
  Widget build(BuildContext context) {
    final c = controller, t = task;
    final following = c.preference?.following == true;
    final muted = c.preference?.muted == true;
    return Container(
      padding: EdgeInsets.fromLTRB(onBack == null ? 20 : 6, 10, 10, 10),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Palette.border)),
      ),
      child: Row(
        children: [
          if (onBack != null) ...[
            IconAction(
              icon: Icons.arrow_back_ios_new_rounded,
              tooltip: 'Back',
              onPressed: onBack,
            ),
            const SizedBox(width: 4),
          ],
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: showDetailsAction ? () => showDetails(context, c) : null,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    t.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 3),
                  Row(
                    children: [
                      Text(
                        t.key,
                        style: const TextStyle(
                          fontFamily: mono,
                          fontSize: 11.5,
                          color: Palette.fgSubtle,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Flexible(child: SessionBadge(session: c.session)),
                    ],
                  ),
                ],
              ),
            ),
          ),
          if (showDetailsAction)
            IconAction(
              icon: Icons.info_outline_rounded,
              tooltip: 'Task details',
              onPressed: () => showDetails(context, c),
            ),
          IconAction(
            icon: muted
                ? Icons.notifications_off_outlined
                : Icons.notifications_none_rounded,
            tooltip: muted ? 'Unmute Task' : 'Mute Task',
            active: muted,
            onPressed: c.online
                ? () =>
                      perform(context, () => c.setPreference({'muted': !muted}))
                : null,
          ),
          Builder(
            builder: (anchor) => IconAction(
              icon: Icons.more_horiz_rounded,
              tooltip: 'Task actions',
              onPressed: () async {
                final hasSession = c.online && c.session != null;
                final action = await showActions<String>(anchor, [
                  ActionItem(
                    'follow',
                    following ? 'Unfollow Task' : 'Follow Task',
                    following
                        ? Icons.bookmark_rounded
                        : Icons.bookmark_outline_rounded,
                    enabled: c.online,
                  ),
                  ActionItem(
                    'stop',
                    'Interrupt',
                    Icons.stop_circle_outlined,
                    enabled: hasSession,
                  ),
                  ActionItem(
                    'retry',
                    'Retry',
                    Icons.replay_rounded,
                    enabled: hasSession,
                  ),
                  ActionItem(
                    'notify',
                    'Notify agent',
                    Icons.campaign_outlined,
                    enabled: hasSession,
                  ),
                  ActionItem(
                    'delete',
                    'Delete Task',
                    Icons.delete_outline_rounded,
                    enabled: c.online,
                    destructive: true,
                  ),
                ], title: '${t.key} · ${t.title}');
                if (action == null || !anchor.mounted) return;
                if (action == 'delete') {
                  await confirmDeleteTask(anchor, c);
                } else if (action == 'follow') {
                  await perform(
                    anchor,
                    () => c.setPreference({'following': !following}),
                  );
                } else {
                  await perform(anchor, () => c.sessionAction(action));
                }
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// The Agent Session's state as a compact badge.
class SessionBadge extends StatelessWidget {
  final Json? session;
  const SessionBadge({super.key, this.session});
  @override
  Widget build(BuildContext context) {
    final state = session?['state'] as String?;
    final queue = session?['queuePosition'];
    final failed =
        (session?['lastJob'] as Map?)?['state'] == 'failed' ||
        session?['held'] == true;
    final (label, color) = switch (state) {
      null => ('No Agent Session', Palette.fgSubtle),
      'running' => ('running', Palette.success),
      'pending' => ('pending', Palette.warning),
      'paused' => ('paused', Palette.warning),
      'closed' => ('closed', Palette.fgSubtle),
      _ when failed => ('needs retry', Palette.danger),
      _ when queue != null => ('queued #$queue', Palette.info),
      _ => (state, Palette.fgMuted),
    };
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        state == 'running'
            ? PulseDot(color: color, size: 6)
            : Dot(color: color, size: 6),
        const SizedBox(width: 5),
        Flexible(
          child: Text(
            label,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11.5, color: color),
          ),
        ),
      ],
    );
  }
}

class _DaySeparator extends StatelessWidget {
  final DateTime date;
  const _DaySeparator({required this.date});
  @override
  Widget build(BuildContext context) {
    final d = date.toLocal(), now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(d.year, d.month, d.day);
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', //
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    final label = day == today
        ? 'Today'
        : day == today.subtract(const Duration(days: 1))
        ? 'Yesterday'
        : '${d.day} ${months[d.month - 1]}${d.year == now.year ? '' : ' ${d.year}'}';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Row(
        children: [
          const Expanded(child: Divider()),
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 10),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
            decoration: BoxDecoration(
              color: Palette.surface,
              borderRadius: BorderRadius.circular(99),
              border: Border.all(color: Palette.border),
            ),
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w500,
                color: Palette.fgMuted,
              ),
            ),
          ),
          const Expanded(child: Divider()),
        ],
      ),
    );
  }
}

class _LiveTail extends StatelessWidget {
  final TaskController controller;
  const _LiveTail({required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller;
    if (c.liveThinking.isEmpty && c.liveText.isEmpty && c.liveStatus.isEmpty) {
      return const SizedBox.shrink();
    }
    final agent = c.agents.where((a) => a.id == c.task?.agentId).firstOrNull;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Avatar(
            label: agent?.name ?? 'Agent',
            emoji: agent?.emoji ?? '🤖',
            size: 32,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Text(
                      agent?.name ?? 'Agent',
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(width: 8),
                    const PulseDot(color: Palette.success, size: 6),
                  ],
                ),
                const SizedBox(height: 6),
                if (c.liveThinking.isNotEmpty)
                  _Collapsible(
                    icon: Icons.psychology_outlined,
                    title: 'Thinking · streaming',
                    child: SelectableText(
                      c.liveThinking,
                      style: const TextStyle(
                        color: Palette.fgMuted,
                        fontSize: 13.5,
                        height: 1.5,
                      ),
                    ),
                  ),
                for (final text in c.liveText.values)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Md('$text ▍', selectable: false, onLink: openLink),
                  ),
                if (c.liveStatus.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Notice(
                      message: c.liveStatus,
                      icon: Icons.hourglass_top_rounded,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class TimelineTile extends StatelessWidget {
  final TimelineEntry entry;
  final TaskController controller;
  final bool grouped;
  const TimelineTile({
    super.key,
    required this.entry,
    required this.controller,
    this.grouped = false,
  });
  @override
  Widget build(BuildContext context) {
    final e = entry;
    if (e.type == 'revision') {
      final changes = objects(
        e.content['changes'],
      ).map((v) => '${v['field']}: ${v['after']}').join(', ');
      return _Meta(
        icon: Icons.edit_note_rounded,
        child: Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: e.author,
                style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  color: Palette.fgMuted,
                ),
              ),
              TextSpan(text: ' changed $changes'),
            ],
          ),
        ),
      );
    }
    if (e.type == 'agent') {
      final payload = e.payload, kind = e.payload['kind'];
      if (kind == 'thinking') {
        return _Indented(
          child: _Collapsible(
            icon: Icons.psychology_outlined,
            title: 'Thinking',
            child: SelectableText(
              payload['text'] as String? ?? '',
              style: const TextStyle(
                color: Palette.fgMuted,
                fontSize: 13.5,
                height: 1.5,
              ),
            ),
          ),
        );
      }
      if (kind == 'activity') {
        final entries = objects(payload['entries']);
        final failed = entries.where((a) => a['status'] == 'error').length;
        return _Indented(
          child: _Collapsible(
            icon: Icons.construction_rounded,
            title: 'Activity',
            trailing: [
              '${entries.length} ${entries.length == 1 ? 'step' : 'steps'}',
              if (failed > 0) '$failed failed',
            ].join(' · '),
            alert: failed > 0,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [for (final a in entries) _Activity(item: a)],
            ),
          ),
        );
      }
      if (kind == 'turn_summary') {
        final summary = payload['summary'] as Map;
        final error = summary['isError'] == true;
        return _Meta(
          icon: error
              ? Icons.error_outline_rounded
              : Icons.check_circle_outline_rounded,
          color: error ? Palette.danger : Palette.fgSubtle,
          child: Text(
            'Turn ${error ? 'failed' : 'completed'} · ${((summary['durationMs'] as num? ?? 0) / 1000).toStringAsFixed(1)}s · ${summary['toolCalls']} tool calls',
            style: TextStyle(color: error ? Palette.danger : null),
          ),
        );
      }
      return _Meta(
        icon: Icons.info_outline_rounded,
        child: SelectableText(payload['text'] as String? ?? ''),
      );
    }
    final kind = e.content['kind'];
    if (kind == 'system') {
      return _Meta(
        icon: Icons.info_outline_rounded,
        child: e.deleted
            ? const Text('Comment deleted')
            : Md(e.body, size: 12.5),
      );
    }
    final own = kind == 'user' && e.authorId == controller.user?.id;
    final agent = kind == 'agent'
        ? controller.agents.where((a) => a.id == e.authorId).firstOrNull ??
              controller.agents
                  .where((a) => a.id == controller.task?.agentId)
                  .firstOrNull
        : null;
    final editable = e.isOwnCommentEditable && own;
    return _CommentView(
      entry: e,
      own: own,
      agent: agent,
      grouped: grouped,
      controller: controller,
      onActions: editable && controller.online
          ? (anchor) => _commentActions(anchor, e)
          : null,
    );
  }

  Future<void> _commentActions(BuildContext anchor, TimelineEntry e) async {
    final action = await showActions<String>(anchor, const [
      ActionItem('copy', 'Copy text', Icons.copy_rounded),
      ActionItem('edit', 'Edit', Icons.edit_outlined),
      ActionItem(
        'delete',
        'Delete',
        Icons.delete_outline_rounded,
        destructive: true,
      ),
    ]);
    if (action == null || !anchor.mounted) return;
    if (action == 'copy') {
      await Clipboard.setData(ClipboardData(text: e.body));
      if (anchor.mounted) toast(anchor, 'Copied', error: false);
    } else if (action == 'delete') {
      final accepted = await confirm(
        anchor,
        title: 'Delete Comment?',
        confirmLabel: 'Delete',
      );
      if (accepted && anchor.mounted) {
        await perform(anchor, () => controller.deleteComment(e.id));
      }
    } else {
      final text = TextEditingController(text: e.body);
      final edited = await showAppSheet<String>(
        anchor,
        builder: (sheet) => SheetScaffold(
          title: 'Edit Comment',
          body: TextField(
            controller: text,
            autofocus: true,
            minLines: 3,
            maxLines: 10,
          ),
          actions: [
            AppButton(
              label: 'Cancel',
              tone: Tone.secondary,
              onPressed: () => Navigator.pop(sheet),
            ),
            AppButton(
              label: 'Save',
              onPressed: () => Navigator.pop(sheet, text.text),
            ),
          ],
        ),
      );
      if (edited != null && anchor.mounted) {
        await perform(anchor, () => controller.editComment(e.id, edited));
      }
    }
  }
}

class _CommentView extends StatelessWidget {
  final TimelineEntry entry;
  final bool own, grouped;
  final Agent? agent;
  final TaskController controller;
  final void Function(BuildContext anchor)? onActions;
  const _CommentView({
    required this.entry,
    required this.own,
    required this.grouped,
    required this.controller,
    this.agent,
    this.onActions,
  });
  @override
  Widget build(BuildContext context) {
    final e = entry, isAgent = e.content['kind'] == 'agent';
    final delivery = e.content['delivery'] as Map?;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (e.internal)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.lock_rounded, size: 12, color: Palette.warning),
                SizedBox(width: 5),
                Flexible(
                  child: Text(
                    'INTERNAL NOTE · never delivered to the Agent',
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 10.5,
                      letterSpacing: .5,
                      color: Palette.warning,
                    ),
                  ),
                ),
              ],
            ),
          ),
        e.deleted
            ? const Text(
                'Comment deleted',
                style: TextStyle(
                  fontStyle: FontStyle.italic,
                  color: Palette.fgSubtle,
                ),
              )
            : Md(e.body, onLink: openLink),
        for (final attachment in e.attachments)
          AttachmentTile(attachment: attachment, controller: controller),
      ],
    );
    final footer = Wrap(
      spacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(_time(e.createdAt), style: _metaStyle),
        if (e.content['editedAt'] != null)
          const Text('· Edited', style: _metaStyle),
        if (delivery != null) _Delivery(delivery: delivery),
      ],
    );
    final actions = onActions == null
        ? null
        : Builder(
            builder: (anchor) => IconAction(
              icon: Icons.more_horiz_rounded,
              tooltip: 'Comment actions',
              size: 26,
              onPressed: () => onActions!(anchor),
            ),
          );

    if (own) {
      return Padding(
        padding: EdgeInsets.only(top: grouped ? 4 : 14, left: 48),
        child: Align(
          alignment: Alignment.centerRight,
          child: Builder(
            builder: (anchor) => GestureDetector(
              onLongPress: onActions == null ? null : () => onActions!(anchor),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Container(
                    padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                    decoration: BoxDecoration(
                      color: e.internal
                          ? Palette.warning.withValues(alpha: .1)
                          : Palette.primary.withValues(alpha: .16),
                      borderRadius: const BorderRadius.only(
                        topLeft: Radius.circular(18),
                        topRight: Radius.circular(18),
                        bottomLeft: Radius.circular(18),
                        bottomRight: Radius.circular(6),
                      ),
                      border: Border.all(
                        color: e.internal
                            ? Palette.warning.withValues(alpha: .35)
                            : Palette.primary.withValues(alpha: .28),
                      ),
                    ),
                    child: body,
                  ),
                  const SizedBox(height: 4),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [?actions, footer],
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }

    final name = Row(
      children: [
        Flexible(
          child: Text(
            e.author,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
          ),
        ),
        if (isAgent) ...[
          const SizedBox(width: 6),
          const Pill(label: 'Agent', color: Palette.primary),
        ],
        const SizedBox(width: 8),
        Text(_time(e.createdAt), style: _metaStyle),
      ],
    );
    return Padding(
      padding: EdgeInsets.only(top: grouped ? 4 : 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 32,
            child: grouped
                ? null
                : Avatar(
                    label: e.author,
                    emoji: isAgent ? agent?.emoji ?? '🤖' : null,
                    seed: e.authorId ?? e.author,
                    size: 32,
                  ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (!grouped) ...[name, const SizedBox(height: 4)],
                isAgent && !e.internal
                    ? body
                    : Container(
                        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                        decoration: BoxDecoration(
                          color: e.internal
                              ? Palette.warning.withValues(alpha: .08)
                              : Palette.surface,
                          borderRadius: const BorderRadius.only(
                            topLeft: Radius.circular(6),
                            topRight: Radius.circular(18),
                            bottomLeft: Radius.circular(18),
                            bottomRight: Radius.circular(18),
                          ),
                          border: Border.all(
                            color: e.internal
                                ? Palette.warning.withValues(alpha: .35)
                                : Palette.border,
                          ),
                        ),
                        child: body,
                      ),
                if (e.content['editedAt'] != null || delivery != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Wrap(
                      spacing: 6,
                      children: [
                        if (e.content['editedAt'] != null)
                          const Text('Edited', style: _metaStyle),
                        if (delivery != null) _Delivery(delivery: delivery),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          ?actions,
        ],
      ),
    );
  }

  static const _metaStyle = TextStyle(fontSize: 11, color: Palette.fgSubtle);

  static String _time(DateTime date) {
    final d = date.toLocal();
    return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }
}

class _Delivery extends StatelessWidget {
  final Map delivery;
  const _Delivery({required this.delivery});
  @override
  Widget build(BuildContext context) {
    final state = delivery['state'] as String?;
    final reason = delivery['reason'] as String?;
    final (icon, color, label) = switch (state) {
      'delivered' => (Icons.done_all_rounded, Palette.primarySoft, 'Delivered'),
      'queued' => (Icons.schedule_rounded, Palette.fgSubtle, 'Queued'),
      'not_delivered' => (
        Icons.error_outline_rounded,
        Palette.danger,
        'Not delivered',
      ),
      _ => (Icons.circle_outlined, Palette.fgSubtle, '$state'),
    };
    return Tooltip(
      message: 'Delivery: $state${reason == null ? '' : ' · $reason'}',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: color),
          const SizedBox(width: 3),
          Text(
            reason == null ? label : '$label · $reason',
            style: TextStyle(fontSize: 11, color: color),
          ),
        ],
      ),
    );
  }
}

/// Small centered line for Revisions, notices and Turn Summaries.
class _Meta extends StatelessWidget {
  final IconData icon;
  final Widget child;
  final Color color;
  const _Meta({
    required this.icon,
    required this.child,
    this.color = Palette.fgSubtle,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(width: 32, child: Icon(icon, size: 15, color: color)),
        const SizedBox(width: 12),
        Expanded(
          child: DefaultTextStyle.merge(
            style: const TextStyle(
              fontSize: 12.5,
              color: Palette.fgSubtle,
              height: 1.4,
            ),
            child: child,
          ),
        ),
      ],
    ),
  );
}

class _Indented extends StatelessWidget {
  final Widget child;
  const _Indented({required this.child});
  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.only(left: 44, top: 6), child: child);
}

class _Collapsible extends StatefulWidget {
  final IconData icon;
  final String title;
  final String? trailing;
  final bool alert;
  final Widget child;
  const _Collapsible({
    required this.icon,
    required this.title,
    required this.child,
    this.trailing,
    this.alert = false,
  });
  @override
  State<_Collapsible> createState() => _CollapsibleState();
}

class _CollapsibleState extends State<_Collapsible> {
  bool _open = false;
  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerLeft,
    child: AnimatedContainer(
      duration: const Duration(milliseconds: 180),
      decoration: BoxDecoration(
        color: _open ? Palette.surface : Colors.transparent,
        borderRadius: BorderRadius.circular(Radii.md),
        border: Border.all(color: Palette.border),
      ),
      child: Column(
        crossAxisAlignment: _open
            ? CrossAxisAlignment.stretch
            : CrossAxisAlignment.start,
        children: [
          Pressable(
            onTap: () => setState(() => _open = !_open),
            pressedScale: 1,
            padding: const EdgeInsets.fromLTRB(10, 6, 8, 6),
            child: Row(
              mainAxisSize: _open ? MainAxisSize.max : MainAxisSize.min,
              children: [
                Icon(
                  widget.icon,
                  size: 15,
                  color: widget.alert ? Palette.danger : Palette.fgMuted,
                ),
                const SizedBox(width: 7),
                Text(
                  widget.title,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w500,
                    color: Palette.fgMuted,
                  ),
                ),
                if (widget.trailing != null) ...[
                  const SizedBox(width: 7),
                  Flexible(
                    fit: _open ? FlexFit.tight : FlexFit.loose,
                    child: Text(
                      widget.trailing!,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: widget.alert ? Palette.danger : Palette.fgSubtle,
                      ),
                    ),
                  ),
                ] else if (_open)
                  const Spacer(),
                const SizedBox(width: 4),
                AnimatedRotation(
                  turns: _open ? .5 : 0,
                  duration: const Duration(milliseconds: 180),
                  child: const Icon(
                    Icons.keyboard_arrow_down_rounded,
                    size: 17,
                    color: Palette.fgSubtle,
                  ),
                ),
              ],
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: widget.child,
            ),
        ],
      ),
    ),
  );
}

class _Activity extends StatefulWidget {
  final Json item;
  const _Activity({required this.item});
  @override
  State<_Activity> createState() => _ActivityState();
}

class _ActivityState extends State<_Activity> {
  bool _open = false;
  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final (icon, color) = switch (item['status']) {
      'ok' => (Icons.check_rounded, Palette.success),
      'error' => (Icons.close_rounded, Palette.danger),
      _ => (Icons.more_horiz_rounded, Palette.warning),
    };
    final children = objects(item['children']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Pressable(
          onTap: () => setState(() => _open = !_open),
          pressedScale: 1,
          borderRadius: BorderRadius.circular(8),
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                margin: const EdgeInsets.only(top: 1),
                width: 18,
                height: 18,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: color.withValues(alpha: .15),
                ),
                child: Icon(icon, size: 12, color: color),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: '${item['name']}',
                        style: const TextStyle(
                          fontFamily: mono,
                          fontWeight: FontWeight.w500,
                          color: Palette.fg,
                        ),
                      ),
                      TextSpan(text: '  ${item['summary']}'),
                      if (item['outcome'] != null)
                        TextSpan(
                          text: '  · ${item['outcome']}',
                          style: TextStyle(color: color),
                        ),
                    ],
                  ),
                  style: const TextStyle(
                    fontSize: 12.5,
                    color: Palette.fgMuted,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
        ),
        if (_open)
          Container(
            margin: const EdgeInsets.fromLTRB(34, 2, 0, 8),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: Palette.sidebar,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Palette.border),
            ),
            child: SelectableText(
              '${item['input']}\n${item['output'] ?? ''}',
              style: const TextStyle(
                fontFamily: mono,
                fontSize: 11.5,
                height: 1.5,
                color: Palette.fgMuted,
              ),
            ),
          ),
        if (_open && children.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(left: 22),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [for (final child in children) _Activity(item: child)],
            ),
          ),
      ],
    );
  }
}

class AttachmentTile extends StatefulWidget {
  final Json attachment;
  final TaskController controller;
  const AttachmentTile({
    super.key,
    required this.attachment,
    required this.controller,
  });
  @override
  State<AttachmentTile> createState() => _AttachmentTileState();
}

class _AttachmentTileState extends State<AttachmentTile> {
  File? _file;
  bool _busy = false;
  @override
  void initState() {
    super.initState();
    _cached();
  }

  Future<void> _cached() async {
    final file = await widget.controller.storage.attachment(
      widget.attachment['id'] as String,
      widget.attachment['filename'] as String,
    );
    if (await file.exists() && mounted) setState(() => _file = file);
  }

  @override
  Widget build(BuildContext context) {
    final image = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/avif',
    ].contains(widget.attachment['contentType']);
    final size = widget.attachment['size'] as num?;
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (image && _file != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(Radii.md),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 240),
                  child: Image.file(
                    _file!,
                    errorBuilder: (_, _, _) =>
                        const Text('Image preview unavailable'),
                  ),
                ),
              ),
            ),
          Pressable(
            onTap: _busy
                ? null
                : () async {
                    setState(() => _busy = true);
                    await perform(context, () async {
                      final file = await widget.controller.downloadAttachment(
                        widget.attachment,
                      );
                      if (mounted) setState(() => _file = file);
                      if (!image) await OpenFilex.open(file.path);
                    });
                    if (mounted) setState(() => _busy = false);
                  },
            color: Colors.black.withValues(alpha: .2),
            border: Border.all(color: Palette.border),
            borderRadius: BorderRadius.circular(10),
            padding: const EdgeInsets.fromLTRB(10, 8, 12, 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 30,
                  height: 30,
                  decoration: BoxDecoration(
                    color: Palette.primary.withValues(alpha: .15),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(
                    image
                        ? Icons.image_outlined
                        : Icons.insert_drive_file_outlined,
                    size: 16,
                    color: Palette.primarySoft,
                  ),
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${widget.attachment['filename']}',
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      Text(
                        [
                          if (size != null) _bytes(size),
                          _file != null ? 'Downloaded' : 'Download',
                        ].join(' · '),
                        style: const TextStyle(
                          fontSize: 11,
                          color: Palette.fgSubtle,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                _busy
                    ? const Spinner(size: 14)
                    : Icon(
                        _file != null
                            ? Icons.download_done_rounded
                            : Icons.download_rounded,
                        size: 17,
                        color: Palette.fgMuted,
                      ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  static String _bytes(num n) => n < 1024
      ? '$n B'
      : n < 1024 * 1024
      ? '${(n / 1024).toStringAsFixed(0)} KB'
      : '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
}

class Composer extends StatefulWidget {
  final TaskController controller;
  const Composer({super.key, required this.controller});
  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  late final TextEditingController _text;
  @override
  void initState() {
    super.initState();
    _text = TextEditingController(text: widget.controller.draft.text);
  }

  @override
  void didUpdateWidget(Composer oldWidget) {
    super.didUpdateWidget(oldWidget);
    final text = widget.controller.draft.text;
    if (_text.text != text) {
      _text.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      );
    }
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _canSend {
    final c = widget.controller;
    return !c.sending && c.online && !c.draft.ambiguous;
  }

  Future<void> _attach() => perform(context, () async {
    final c = widget.controller;
    final result = await FilePicker.pickFiles();
    if (result.isEmpty) return;
    final files = result
        .where((f) => f.path != null)
        .map((f) => DraftFile(f.path!, f.name))
        .toList();
    if (c.draft.files.length + files.length > 10 ||
        result.any((f) => (f.lengthSync() ?? 0) > 25 * 1024 * 1024)) {
      throw StateError('At most 10 files, 25 MB each');
    }
    final staged = <DraftFile>[];
    for (final file in files) {
      staged.add(await c.storage.stageAttachment(file));
    }
    await c.setDraft(c.draft.copyWith(files: [...c.draft.files, ...staged]));
  });

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, draft = widget.controller.draft;
    final accent = draft.internal ? Palette.warning : Palette.primary;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (draft.ambiguous)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Notice(
                  icon: Icons.help_outline_rounded,
                  message:
                      'Send outcome unknown. Check the refreshed conversation.',
                  actionLabel: 'Refresh and review',
                  onAction: c.online
                      ? () => perform(context, c.reconcileSend)
                      : null,
                ),
              ),
            AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              decoration: BoxDecoration(
                color: draft.internal
                    ? Color.alphaBlend(
                        Palette.warning.withValues(alpha: .06),
                        Palette.surface,
                      )
                    : Palette.surface,
                borderRadius: BorderRadius.circular(Radii.xl),
                border: Border.all(
                  color: draft.internal
                      ? Palette.warning.withValues(alpha: .45)
                      : Palette.borderStrong,
                ),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x55000000),
                    blurRadius: 24,
                    offset: Offset(0, 8),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(8, 8, 12, 0),
                    child: Row(
                      children: [
                        Flexible(
                          child: Segmented<bool>(
                            key: const Key('internal-toggle'),
                            value: draft.internal,
                            onChanged: c.sending
                                ? null
                                : (v) =>
                                      c.setDraft(c.draft.copyWith(internal: v)),
                            segments: const [
                              Segment(
                                false,
                                'Comment',
                                icon: Icons.chat_bubble_outline_rounded,
                              ),
                              Segment(
                                true,
                                'Internal Note',
                                icon: Icons.lock_outline_rounded,
                                color: Palette.warning,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (!c.online || draft.internal)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 6, 14, 0),
                      child: Row(
                        children: [
                          Icon(
                            c.online
                                ? Icons.visibility_off_outlined
                                : Icons.cloud_off_rounded,
                            size: 13,
                            color: Palette.warning,
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              !c.online
                                  ? 'Draft saved offline'
                                  : 'Never delivered to the Agent',
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 11.5,
                                color: Palette.warning,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (draft.files.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
                      child: Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final file in draft.files)
                            _DraftChip(
                              file: file,
                              onRemove: c.sending
                                  ? null
                                  : () => c.setDraft(
                                      draft.copyWith(
                                        files: draft.files
                                            .where((f) => f != file)
                                            .toList(),
                                      ),
                                    ),
                            ),
                        ],
                      ),
                    ),
                  if (!draft.internal)
                    SkillSuggestions(
                      text: _text,
                      skills: c.session?['commands'] is List
                          ? objects(
                              c.session?['commands'],
                            ).map(SkillCommand.fromJson).toList()
                          : c.agents
                                    .where((a) => a.id == c.task?.agentId)
                                    .firstOrNull
                                    ?.skillCommands ??
                                [],
                      onSelected: (value) =>
                          c.setDraft(c.draft.copyWith(text: value)),
                    ),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(6, 0, 0, 7),
                        child: IconAction(
                          icon: Icons.add_rounded,
                          tooltip: 'Attach local files',
                          size: 36,
                          onPressed: c.sending ? null : _attach,
                        ),
                      ),
                      Expanded(
                        child: CallbackShortcuts(
                          bindings: {
                            const SingleActivator(
                              LogicalKeyboardKey.enter,
                              meta: true,
                            ): () {
                              if (_canSend) perform(context, c.send);
                            },
                            const SingleActivator(
                              LogicalKeyboardKey.enter,
                              control: true,
                            ): () {
                              if (_canSend) perform(context, c.send);
                            },
                          },
                          child: TextField(
                            key: const Key('comment-composer'),
                            controller: _text,
                            enabled: !c.sending,
                            minLines: 1,
                            maxLines: 6,
                            maxLength: 100000,
                            textCapitalization: TextCapitalization.sentences,
                            style: const TextStyle(fontSize: 15, height: 1.4),
                            decoration: InputDecoration(
                              hintText: draft.internal
                                  ? 'Write an Internal Note…'
                                  : 'Write a Comment…',
                              counterText: '',
                              filled: false,
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              disabledBorder: InputBorder.none,
                              contentPadding: const EdgeInsets.fromLTRB(
                                8,
                                14,
                                8,
                                14,
                              ),
                            ),
                            onChanged: (v) =>
                                c.setDraft(c.draft.copyWith(text: v)),
                          ),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(0, 0, 8, 7),
                        child: Tooltip(
                          message: draft.internal
                              ? 'Post Internal Note'
                              : 'Send',
                          child: AnimatedOpacity(
                            opacity: _canSend ? 1 : .4,
                            duration: const Duration(milliseconds: 150),
                            child: Pressable(
                              key: const Key('send-comment'),
                              onTap: _canSend
                                  ? () => perform(context, c.send)
                                  : null,
                              semanticLabel: draft.internal
                                  ? 'Post Internal Note'
                                  : 'Send',
                              pressedScale: .9,
                              color: accent,
                              hoverColor: const Color(0x22ffffff),
                              borderRadius: BorderRadius.circular(99),
                              child: SizedBox.square(
                                dimension: 36,
                                child: c.sending
                                    ? const Padding(
                                        padding: EdgeInsets.all(10),
                                        child: Spinner(
                                          size: 16,
                                          color: Colors.white,
                                        ),
                                      )
                                    : Icon(
                                        draft.internal
                                            ? Icons.lock_rounded
                                            : Icons.arrow_upward_rounded,
                                        size: 19,
                                        color: draft.internal
                                            ? const Color(0xff2a1d05)
                                            : Colors.white,
                                      ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DraftChip extends StatelessWidget {
  final DraftFile file;
  final VoidCallback? onRemove;
  const _DraftChip({required this.file, this.onRemove});
  @override
  Widget build(BuildContext context) => Tooltip(
    message: '${file.name} · local, not uploaded',
    child: Container(
      padding: const EdgeInsets.fromLTRB(10, 4, 4, 4),
      decoration: BoxDecoration(
        color: Palette.muted,
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: Palette.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.attach_file_rounded, size: 14),
          const SizedBox(width: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 180),
            child: Text(
              file.name,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12),
            ),
          ),
          IconAction(
            icon: Icons.close_rounded,
            tooltip: 'Remove attachment',
            size: 24,
            onPressed: onRemove,
          ),
        ],
      ),
    ),
  );
}
