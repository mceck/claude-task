import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:material_ui/material_ui.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:open_filex/open_filex.dart';

import 'app.dart';
import 'controller.dart';
import 'voice_widgets.dart';
import 'models.dart';
import 'questions.dart';
import 'scheduled.dart';
import 'task_forms.dart';
import 'wiki.dart';
import 'uploads.dart';
import 'ui/markdown.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';
import 'ui/user_avatar.dart';
import 'ui/skill_suggestions.dart';
import 'ui/mention_suggestions.dart';

/// Within this distance of the bottom, the Timeline follows new content.
const _followSlack = 80.0;

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

  /// Hides Revisions (field changes), leaving only the conversation.
  bool _hideChanges = true;
  String? _readId;
  String _stamp = '';
  bool _contentChanged = false;
  bool _settling = false;

  /// Where each laid-out entry ended, counted up from the bottom of the
  /// Timeline, and the scroll offset, at the last layout.
  Map<RenderBox, double> _edges = const {};
  double _measuredPixels = 0;

  /// Entries already shown; anything else arriving later animates in.
  Set<String>? _seen;
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
    final bottom = _scroll.position.pixels < _followSlack;
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

  /// Keeps what the reader is looking at in place: the Timeline is built from
  /// the bottom up, so content arriving below them (the Live Turn preview
  /// growing, a new entry, the Agent Comment replacing it) would carry it off
  /// screen, and reading back through a running Turn would keep drifting.
  ///
  /// Called by [_ReadingSliverList] while laying out, after the entries took
  /// their new size, and returns the offset correction for the viewport to
  /// apply before it paints: the frame that shows the new content is already
  /// where it belongs, instead of sliding and then snapping back.
  double _holdReading(RenderSliverList list) {
    if (!_scroll.hasClients) return 0;
    final position = _scroll.position;
    final pixels = position.pixels;
    final before = _edges;
    final edges = <RenderBox, double>{};
    // The lowest entry on screen that was already there at the last layout
    // says how far everything below the reader moved: entries are anchored to
    // their far edge, counted from the bottom, so they all move together.
    double? shift;
    for (
      RenderBox? entry = list.firstChild;
      entry != null;
      entry = list.childAfter(entry)
    ) {
      final data = entry.parentData;
      if (!entry.hasSize || data is! SliverMultiBoxAdaptorParentData) continue;
      final offset = data.layoutOffset;
      if (offset == null) continue;
      final edge = offset + entry.size.height;
      edges[entry] = edge;
      final was = before[entry];
      if (shift == null && was != null && edge > pixels) shift = edge - was;
    }
    // The Timeline moved since the last layout for a reason of its own (the
    // reader scrolled, a box opened, this correction landed): leave it be.
    final elsewhere = pixels != _measuredPixels;
    _edges = edges;
    _measuredPixels = pixels;
    if (elsewhere) return 0;
    // Following: the newest content stays on screen.
    if (pixels < _followSlack) {
      return _contentChanged && pixels != 0 ? -pixels : 0;
    }
    if (shift == null || shift == 0) return 0;
    final target = (pixels + shift).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    return target - pixels;
  }

  void _afterContent() {
    final c = widget.controller;
    final stamp =
        '${c.timeline.isEmpty ? '' : c.timeline.last.id}:${c.liveText.values.join().length}:${c.timeline.length}';
    if (stamp != _stamp) {
      _stamp = stamp;
      _contentChanged = true;
    }
    if (_settling) return;
    _settling = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _settling = false;
      _contentChanged = false;
      if (mounted) _markReached();
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
    if (_seen == null && c.timeline.isNotEmpty) {
      _seen = {for (final e in c.timeline) e.id};
    }
    final rows = _rows(c);
    final live =
        c.liveThinking.isNotEmpty ||
        c.liveText.isNotEmpty ||
        c.liveStatus.isNotEmpty ||
        c.liveSetup != null;
    return Column(
      children: [
        _Header(
          controller: c,
          task: t,
          onBack: widget.onBack,
          showDetailsAction: widget.showDetailsAction,
        ),
        if (c.wiki == null) TaskVoiceRoom(controller: c, task: t),
        if (c.assignmentRetryId != null && c.assignmentRetryTaskId == t.id)
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
                    : CustomScrollView(
                        key: const Key('timeline'),
                        controller: _scroll,
                        reverse: true,
                        slivers: [
                          SliverPadding(
                            padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
                            sliver: _ReadingSliverList(
                              hold: _holdReading,
                              delegate: SliverChildBuilderDelegate(
                                childCount: rows.length + 2,
                                // Entries keep their element (open sections,
                                // loaded images, measured heights) when newer
                                // ones arrive.
                                findChildIndexCallback: (key) {
                                  if (key is! ValueKey<String>) return null;
                                  final i = rows.indexWhere(
                                    (r) => r.entry.id == key.value,
                                  );
                                  return i < 0 ? null : rows.length - i;
                                },
                                (context, index) {
                                  if (index == 0) {
                                    return _LiveTail(controller: c);
                                  }
                                  if (index == rows.length + 1) {
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
                                                onPressed: c.online
                                                    ? _loadOlder
                                                    : null,
                                              ),
                                            ),
                                          );
                                  }
                                  final i = rows.length - index;
                                  final entry = rows[i].entry;
                                  final previous = i > 0
                                      ? rows[i - 1].entry
                                      : null;
                                  final newDay =
                                      previous == null ||
                                      !_sameDay(
                                        previous.createdAt,
                                        entry.createdAt,
                                      );
                                  // Agent output was already on screen as the
                                  // live tail.
                                  final fresh =
                                      (_seen?.add(entry.id) ?? false) &&
                                      entry.type != 'agent' &&
                                      entry.content['kind'] != 'agent';
                                  return FadeSlideIn(
                                    key: ValueKey(entry.id),
                                    enabled: fresh,
                                    duration: Motion.fast,
                                    offset: Offset.zero,
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.stretch,
                                      children: [
                                        if (newDay)
                                          _DaySeparator(date: entry.createdAt),
                                        TimelineTile(
                                          entry: entry,
                                          controller: c,
                                          count: rows[i].count,
                                          grouped:
                                              !newDay &&
                                              _continues(previous, entry),
                                        ),
                                      ],
                                    ),
                                  );
                                },
                              ),
                            ),
                          ),
                        ],
                      ),
              ),
              if (c.wiki == null)
                Positioned(
                  top: 8,
                  right: 12,
                  child: _ChangesToggle(
                    hidden: _hideChanges,
                    onChanged: (v) => setState(() => _hideChanges = v),
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
                                    color: Palette.primarySoft,
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
        _ActiveRunsBar(controller: c),
        if (c.chatReadOnlyReason != null)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Notice(
              key: const Key('chat-read-only'),
              message: c.chatReadOnlyReason!,
            ),
          )
        else ...[
          ScheduledSection(controller: c),
          Composer(key: ValueKey('composer:${t.id}'), controller: c),
        ],
      ],
    );
  }

  static bool _sameDay(DateTime a, DateTime b) {
    final x = a.toLocal(), y = b.toLocal();
    return x.year == y.year && x.month == y.month && x.day == y.day;
  }

  /// Consecutive Comments by the same author within a few minutes share a header.
  /// The Timeline as shown: Revisions hidden, or identical consecutive ones
  /// by the same actor folded into the latest with a count.
  List<({TimelineEntry entry, int count})> _rows(TaskController c) {
    final rows = <({TimelineEntry entry, int count})>[];
    String? lastText;
    for (final e in c.timeline) {
      if (e.type != 'revision') {
        rows.add((entry: e, count: 1));
        lastText = null;
        continue;
      }
      if (_hideChanges) continue;
      final text = revisionText(e, c);
      if (lastText == text && rows.last.entry.author == e.author) {
        rows[rows.length - 1] = (entry: e, count: rows.last.count + 1);
      } else {
        rows.add((entry: e, count: 1));
      }
      lastText = text;
    }
    return rows;
  }

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
    final c = controller, t = task, session = c.session;
    final following = c.preference?.following == true;
    final muted = c.preference?.muted == true;
    final running = c.online && session?['state'] == 'running';
    final retry =
        c.online &&
        t.agentId != null &&
        _held(session) &&
        session?['state'] != 'running';
    final unseen = c.online && session?['unseenChanges'] == true;
    return PageHeader(
      onBack: onBack,
      title: c.wiki != null ? (c.openChat?.title ?? t.title) : t.title,
      onTitleTap: showDetailsAction ? () => showDetails(context, c) : null,
      meta: Row(
        children: [
          Text(
            c.wiki == null ? t.key : 'Wiki',
            style: const TextStyle(
              fontFamily: mono,
              fontSize: 11.5,
              color: Palette.fgSubtle,
            ),
          ),
          const SizedBox(width: 8),
          Flexible(
            child: AnimatedSwitcher(
              duration: Motion.medium,
              layoutBuilder: (current, previous) => Stack(
                alignment: Alignment.centerLeft,
                children: [...previous, ?current],
              ),
              child: SessionBadge(
                key: ValueKey(sessionLabel(session)),
                session: session,
              ),
            ),
          ),
          // Beside the state it acts on, in free space: showing it
          // never shifts the title or the header actions.
          for (final action in [
            if (running) _PillAction.stop,
            if (retry) _PillAction.retry,
            if (unseen) _PillAction.notify,
          ]) ...[
            const SizedBox(width: 6),
            _SessionPill(
              action: action,
              onTap: () => perform(context, () => c.sessionAction(action.name)),
            ),
          ],
        ],
      ),
      actions: [
        if (showDetailsAction && c.wiki == null)
          IconAction(
            icon: Icons.info_outline_rounded,
            tooltip: 'Task details',
            onPressed: () => showDetails(context, c),
          ),
        IconAction(
          icon: muted
              ? Icons.notifications_off_outlined
              : Icons.notifications_none_rounded,
          tooltip: c.wiki != null
              ? (muted ? 'Unmute wiki' : 'Mute wiki')
              : (muted ? 'Unmute Task' : 'Mute Task'),
          active: muted,
          onPressed: c.online
              ? () => perform(context, () => c.setPreference({'muted': !muted}))
              : null,
        ),
        Builder(
          builder: (anchor) => IconAction(
            icon: Icons.more_horiz_rounded,
            tooltip: c.wiki == null ? 'Task actions' : 'Wiki actions',
            onPressed: () async {
              final action = await showActions<String>(anchor, [
                ActionItem(
                  'follow',
                  c.wiki != null
                      ? (following ? 'Unfollow wiki' : 'Follow wiki')
                      : (following ? 'Unfollow Task' : 'Follow Task'),
                  following
                      ? Icons.bookmark_rounded
                      : Icons.bookmark_outline_rounded,
                  enabled: c.online,
                ),
                ActionItem(
                  'stop',
                  'Stop',
                  Icons.stop_circle_outlined,
                  enabled: running,
                ),
                ActionItem(
                  'retry',
                  'Retry',
                  Icons.replay_rounded,
                  enabled: c.online && t.agentId != null && _held(session),
                ),
                ActionItem(
                  'notify',
                  'Notify agent',
                  Icons.campaign_outlined,
                  enabled: c.online && session?['unseenChanges'] == true,
                ),
                ActionItem(
                  'auto-resume',
                  'Automatic resume at limit',
                  t.autoResume
                      ? Icons.check_box_rounded
                      : Icons.check_box_outline_blank_rounded,
                  enabled: c.online,
                ),
                if (c.wiki != null)
                  ActionItem(
                    'wiki-settings',
                    'Wiki settings',
                    Icons.settings_outlined,
                    enabled: c.online,
                  ),
                ActionItem(
                  'delete',
                  c.wiki == null ? 'Delete Task' : 'Delete wiki',
                  Icons.delete_outline_rounded,
                  enabled: c.online,
                  destructive: true,
                ),
              ], title: '${t.key} · ${t.title}');
              if (action == null || !anchor.mounted) return;
              if (action == 'wiki-settings') {
                await showWikiForm(anchor, c, wiki: c.wiki);
              } else if (action == 'delete') {
                if (c.wiki != null) {
                  await confirmDeleteWiki(anchor, c);
                } else {
                  await confirmDeleteTask(anchor, c);
                }
              } else if (action == 'auto-resume') {
                await perform(anchor, () => c.setAutoResume(!t.autoResume));
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
    );
  }
}

bool _held(Json? session) =>
    session?['held'] == true ||
    (session?['lastJob'] as Map?)?['state'] == 'failed';

/// The web frontend's wording: "queued #2", "running", "waiting for messages"…
String sessionLabel(Json? session) {
  if (session == null) return 'No Agent Session';
  if (_held(session) && session['state'] != 'running') {
    return 'waiting for retry';
  }
  final queue = session['queuePosition'];
  if (queue != null) return 'queued #$queue';
  return switch (session['state']) {
    'pending' => 'starting',
    'idle' => 'waiting for messages',
    final String state => state,
    _ => 'unknown',
  };
}

/// The Agent Session's state as a compact chip.
class SessionBadge extends StatelessWidget {
  final Json? session;
  const SessionBadge({super.key, this.session});
  @override
  Widget build(BuildContext context) {
    final state = session?['state'] as String?;
    final held = _held(session) && state != 'running';
    final color = session == null
        ? Palette.fgSubtle
        : sessionColor(
            state,
            queued: session?['queuePosition'] != null,
            held: held,
          );
    return Container(
      padding: const EdgeInsets.fromLTRB(6, 2, 8, 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .1),
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: color.withValues(alpha: .22)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          state == 'running'
              ? PulseDot(color: color, size: 6)
              : Dot(color: color, size: 6),
          const SizedBox(width: 5),
          Flexible(
            child: Text(
              sessionLabel(session),
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w500,
                color: Color.lerp(color, Colors.white, .2),
                height: 1.3,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

enum _PillAction {
  stop(Icons.stop_rounded, 'Stop', 'Stop the Agent', Palette.danger),
  retry(
    Icons.replay_rounded,
    'Retry',
    'The last Job failed: retry it',
    Palette.danger,
  ),
  notify(
    Icons.campaign_outlined,
    'Notify',
    'The Agent hasn’t seen the latest Task changes: notify it',
    Palette.warning,
  );

  final IconData icon;
  final String label, detail;
  final Color color;
  const _PillAction(this.icon, this.label, this.detail, this.color);
}

/// A Session action as a small pill beside the Session state, in the header's
/// free space: it takes no room from the conversation or the composer.
class _SessionPill extends StatelessWidget {
  final _PillAction action;
  final VoidCallback onTap;
  const _SessionPill({required this.action, required this.onTap});
  @override
  Widget build(BuildContext context) => Tooltip(
    message: action.detail,
    child: Pressable(
      key: Key('session-${action.name}'),
      onTap: onTap,
      semanticLabel: action.detail,
      pressedScale: .94,
      color: action.color.withValues(alpha: .12),
      border: Border.all(color: action.color.withValues(alpha: .3)),
      borderRadius: BorderRadius.circular(99),
      padding: const EdgeInsets.fromLTRB(6, 2, 8, 2),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(action.icon, size: 12, color: action.color),
          const SizedBox(width: 3),
          Text(
            action.label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: action.color,
              height: 1.3,
            ),
          ),
        ],
      ),
    ),
  );
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

/// What the running Turn is writing right now, like the web's live view.
class _LiveTail extends StatelessWidget {
  final TaskController controller;
  const _LiveTail({required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller;
    final setup = c.liveSetup;
    final streaming =
        c.liveThinking.isNotEmpty ||
        c.liveText.isNotEmpty ||
        c.liveStatus.isNotEmpty;
    final agent = c.agents.byId(c.task?.agentId);
    // No size or fade transition: the stored entry replaces this in the same
    // frame, so animating here would show a gap or a flicker.
    if (!streaming && setup == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Preparation output, as on the web: it shows before Claude starts
          // and the Activity item, or the Turn Summary, clears it.
          if (setup != null)
            Padding(
              padding: EdgeInsets.only(bottom: streaming ? 10 : 0),
              child: _Collapsible(
                icon: Icons.terminal_rounded,
                title: 'Preparing the worktree',
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 240),
                  child: SingleChildScrollView(
                    child: SelectableText(
                      setup['output'] as String? ?? '',
                      style: const TextStyle(
                        fontFamily: mono,
                        fontSize: 11.5,
                        height: 1.5,
                        color: Palette.fgMuted,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (streaming)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                UserAvatar(
                  label: agent?.name ?? 'Agent',
                  emoji: agent?.emoji ?? '🤖',
                  imageUrl: agent?.avatarImageUrl,
                  api: controller.api,
                  size: 32,
                  circle: false,
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
                          const SizedBox(width: 6),
                          const Pill(label: 'Agent', color: Palette.agent),
                          const SizedBox(width: 8),
                          const TypingDots(),
                        ],
                      ),
                      const SizedBox(height: 6),
                      if (c.liveThinking.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: _Collapsible(
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
                        ),
                      for (final MapEntry(:key, value: text)
                          in c.liveText.entries)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: DashedOutline(
                            color: Palette.agent,
                            borderRadius: _bubbleRadius(own: false),
                            child: Padding(
                              padding: const EdgeInsets.fromLTRB(
                                14,
                                10,
                                14,
                                10,
                              ),
                              child: _Clamped(
                                key: ValueKey(key),
                                fade: Palette.bg,
                                expanded: c.liveExpanded.contains(key),
                                onExpandedChanged: (expanded) => expanded
                                    ? c.liveExpanded.add(key)
                                    : c.liveExpanded.remove(key),
                                child: Md(
                                  '$text ▍',
                                  selectable: false,
                                  onLink: openLink,
                                ),
                              ),
                            ),
                          ),
                        ),
                      if (c.liveStatus.isNotEmpty)
                        Notice(
                          message: c.liveStatus,
                          icon: Icons.hourglass_top_rounded,
                        ),
                    ],
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

/// A Revision's changes in words.
String revisionText(TimelineEntry e, TaskController c) {
  final described = [
    for (final change in objects(e.content['changes']))
      describeChange(change, c),
  ];
  return described.length < 2
      ? described.join()
      : '${described.take(described.length - 1).join(', ')} and ${described.last}';
}

/// Small overlay badge over the Timeline's top corner; it never takes a band of the chat.
class _ChangesToggle extends StatelessWidget {
  final bool hidden;
  final ValueChanged<bool> onChanged;
  const _ChangesToggle({required this.hidden, required this.onChanged});
  @override
  Widget build(BuildContext context) => Pressable(
    key: const Key('hide-changes'),
    onTap: () => onChanged(!hidden),
    color: Palette.raised.withValues(alpha: .92),
    border: Border.all(color: Palette.borderStrong),
    borderRadius: BorderRadius.circular(99),
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          hidden ? Icons.visibility_off_outlined : Icons.visibility_outlined,
          size: 12,
          color: hidden ? Palette.fgMuted : Palette.fgSubtle,
        ),
        const SizedBox(width: 4),
        Text(
          'Changes',
          style: TextStyle(
            fontSize: 11,
            color: hidden ? Palette.fgMuted : Palette.fgSubtle,
          ),
        ),
      ],
    ),
  );
}

class TimelineTile extends StatelessWidget {
  final TimelineEntry entry;
  final TaskController controller;
  final bool grouped;

  /// How many identical Revisions this tile stands for.
  final int count;
  const TimelineTile({
    super.key,
    required this.entry,
    required this.controller,
    this.grouped = false,
    this.count = 1,
  });
  @override
  Widget build(BuildContext context) {
    final e = entry;
    if (e.type == 'revision') {
      final changes = objects(e.content['changes']);
      final text = revisionText(e, controller);
      return _Meta(
        icon: changeIcon(changes.firstOrNull?['field'] as String?),
        ringed: true,
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
              TextSpan(text: ' $text'),
              if (count > 1) TextSpan(text: ' ×$count'),
              TextSpan(text: ' · ${_CommentView._time(e.createdAt)}'),
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
            color: Palette.agent,
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
      if (kind == 'run') {
        final run = Map<String, dynamic>.from(payload['run'] as Map)
          ..['id'] = e.id;
        return _RunTrace(controller: controller, run: run);
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
    if (e.deleted) {
      return _Meta(
        icon: Icons.delete_outline_rounded,
        ringed: true,
        child: Text(
          '${e.author} deleted a comment · ${_CommentView._time(e.createdAt)}',
          style: const TextStyle(fontStyle: FontStyle.italic),
        ),
      );
    }
    if (e.answersCommentId != null) {
      final delivery = e.content['delivery'] as Map?;
      return _Meta(
        icon: Icons.task_alt_rounded,
        ringed: true,
        child: Wrap(
          spacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: e.author,
                    style: const TextStyle(
                      fontWeight: FontWeight.w600,
                      color: Palette.fgMuted,
                    ),
                  ),
                  TextSpan(
                    text:
                        ' answered the question · ${_CommentView._time(e.createdAt)}',
                  ),
                ],
              ),
            ),
            if (delivery != null) _Delivery(delivery: delivery),
          ],
        ),
      );
    }
    final own = kind == 'user' && e.authorId == controller.user?.id;
    final agent = kind == 'agent'
        ? controller.agents.byId(e.authorId) ??
              controller.agents.byId(controller.task?.agentId)
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
        message: 'Its attachments are deleted too.',
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

IconData changeIcon(String? field) => switch (field) {
  'title' => Icons.title_rounded,
  'description' => Icons.notes_rounded,
  'statusId' => Icons.swap_horiz_rounded,
  'priority' => Icons.flag_outlined,
  'tagIds' => Icons.sell_outlined,
  'assigneeIds' => Icons.person_outline_rounded,
  'agentId' => Icons.smart_toy_outlined,
  'pullRequest' => Icons.merge_rounded,
  _ => Icons.edit_note_rounded,
};

/// A Revision change in words, as the web Timeline says it.
String describeChange(Json change, TaskController c) {
  final before = change['before'], after = change['after'];
  String status(Object? id) => c.statuses.byId(id)?.name ?? 'a deleted status';
  String tag(Object? id) => c.tags.byId(id)?.name ?? 'a deleted tag';
  String user(Object? id) => c.users.byId(id)?.displayName ?? 'someone';
  String agent(Object? id) => c.agents.byId(id)?.name ?? 'a deleted agent';
  String plural(int n, String word) => n == 1 ? word : '${word}s';
  final was = strings(before is List ? before : const []);
  final now = strings(after is List ? after : const []);
  final added = now.where((x) => !was.contains(x)).toList();
  final removed = was.where((x) => !now.contains(x)).toList();
  switch (change['field']) {
    case 'title':
      return 'renamed the task from “$before” to “$after”';
    case 'description':
      return 'updated the description';
    case 'statusId':
      return 'moved it from ${status(before)} to ${status(after)}';
    case 'priority':
      return 'changed priority from $before to $after';
    case 'tagIds':
      return [
        if (added.isNotEmpty)
          'added ${plural(added.length, 'tag')} ${added.map(tag).join(', ')}',
        if (removed.isNotEmpty)
          'removed ${plural(removed.length, 'tag')} ${removed.map(tag).join(', ')}',
      ].join(' and ');
    case 'assigneeIds':
      return [
        if (added.isNotEmpty) 'assigned ${added.map(user).join(', ')}',
        if (removed.isNotEmpty) 'unassigned ${removed.map(user).join(', ')}',
      ].join(' and ');
    case 'agentId':
      if (after == null) return 'unassigned the agent ${agent(before)}';
      return before == null
          ? 'assigned the agent ${agent(after)}'
          : 'reassigned the task from ${agent(before)} to ${agent(after)}';
    case 'pullRequest':
      final pr = (after ?? before) as Map?;
      final gitlab = pr?['provider'] == 'gitlab';
      final noun = gitlab ? 'merge request' : 'pull request';
      if (after == null) return 'removed the $noun link';
      final state = pr?['state'] == 'open' && pr?['draft'] == true
          ? 'draft'
          : pr?['state'];
      return 'updated $noun ${gitlab ? '!' : '#'}${pr?['number']} ($state)';
    default:
      return 'changed ${change['field']}';
  }
}

BorderRadius _bubbleRadius({required bool own}) => BorderRadius.only(
  topLeft: Radius.circular(own ? 18 : 6),
  topRight: Radius.circular(own ? 6 : 18),
  bottomLeft: const Radius.circular(18),
  bottomRight: const Radius.circular(18),
);

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
    final e = entry, kind = e.content['kind'];
    final isAgent = kind == 'agent', isSystem = kind == 'system';
    final delivery = e.content['delivery'] as Map?;
    final question = e.question, survey = e.survey;
    final limitResume = e.limitResume;
    // Claude uses orange; Internal chat stays gray and System notices use amber.
    final line = e.internal
        ? Palette.slate.withValues(alpha: .65)
        : isAgent
        ? Palette.agent
        : isSystem
        ? Palette.warning.withValues(alpha: .85)
        : own
        ? Palette.primary.withValues(alpha: .85)
        : Palette.borderStrong;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (e.internal)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.lock_rounded, size: 12, color: Palette.slate),
                SizedBox(width: 5),
                Flexible(
                  child: Text(
                    'Internal chat',
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      fontSize: 11,
                      color: Palette.slate,
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (question != null)
          QuestionCard(
            key: ValueKey('question:${e.id}'),
            commentId: e.id,
            question: question,
            controller: controller,
          )
        else if (survey != null)
          SurveyCard(
            key: ValueKey('survey:${e.id}'),
            commentId: e.id,
            survey: survey,
            controller: controller,
          )
        else if (e.body.isNotEmpty)
          _Clamped(
            fade: Palette.bg,
            expanded: controller.expandedComments.contains(e.id),
            child: Md(e.body, size: isSystem ? 13.5 : 14.5, onLink: openLink),
          ),
        if (limitResume != null)
          Padding(
            padding: EdgeInsets.only(top: e.body.isEmpty ? 0 : 10),
            child: LimitResumeCard(
              key: ValueKey('limit-resume:${e.id}'),
              commentId: e.id,
              offer: limitResume,
              controller: controller,
            ),
          ),
        for (final attachment in e.attachments)
          AttachmentTile(attachment: attachment, controller: controller),
      ],
    );
    final bubble = _Bubble(
      line: line,
      dashed: e.internal,
      radius: _bubbleRadius(own: own),
      child: body,
    );
    final meta = [
      if (e.content['editedAt'] != null)
        const Text('Edited', style: _metaStyle),
      if (delivery != null) _Delivery(delivery: delivery),
    ];
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
                  bubble,
                  const SizedBox(height: 4),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ?actions,
                      Wrap(
                        spacing: 6,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(_time(e.createdAt), style: _metaStyle),
                          ...meta,
                        ],
                      ),
                    ],
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
          const Pill(label: 'Agent', color: Palette.agent),
        ],
        if (isSystem) ...[
          const SizedBox(width: 6),
          const Pill(label: 'System', color: Palette.warning),
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
                : isSystem
                ? Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: Palette.warning.withValues(alpha: .14),
                    ),
                    child: const Icon(
                      Icons.warning_amber_rounded,
                      size: 17,
                      color: Palette.warning,
                    ),
                  )
                : !isAgent
                ? UserAvatar(
                    key: ValueKey('comment-avatar:${e.id}'),
                    label: e.author,
                    userId: e.authorId,
                    imageUrl: controller.users.byId(e.authorId)?.avatarImageUrl,
                    api: controller.api,
                    size: 32,
                  )
                : UserAvatar(
                    label: e.author,
                    emoji: agent?.emoji ?? '🤖',
                    imageUrl: agent?.avatarImageUrl,
                    api: controller.api,
                    userId: e.authorId ?? e.author,
                    size: 32,
                    circle: !isAgent,
                  ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (!grouped) ...[name, const SizedBox(height: 5)],
                bubble,
                if (meta.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Wrap(spacing: 6, children: meta),
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

class _Bubble extends StatelessWidget {
  final Color line;
  final bool dashed;
  final BorderRadius radius;
  final Widget child;
  const _Bubble({
    required this.line,
    required this.radius,
    required this.child,
    this.dashed = false,
  });
  @override
  Widget build(BuildContext context) {
    final box = Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      decoration: BoxDecoration(
        borderRadius: radius,
        border: dashed ? null : Border.all(color: line),
      ),
      child: child,
    );
    return dashed
        ? DashedOutline(color: line, borderRadius: radius, child: box)
        : box;
  }
}

/// A [SliverList] that asks [hold] for a scroll offset correction right after
/// its entries take their new size, and reports it to the viewport, which
/// applies it and lays out again before painting. Asking from inside the
/// list's own layout is what lets [hold] read the entries' sizes.
class _ReadingSliverList extends SliverList {
  const _ReadingSliverList({required this.hold, required super.delegate});

  final double Function(RenderSliverList list) hold;

  @override
  RenderSliverList createRenderObject(BuildContext context) =>
      _RenderReadingSliverList(
        childManager: context as SliverMultiBoxAdaptorElement,
        hold: hold,
      );

  @override
  void updateRenderObject(
    BuildContext context,
    _RenderReadingSliverList renderObject,
  ) {
    renderObject.hold = hold;
  }
}

class _RenderReadingSliverList extends RenderSliverList {
  _RenderReadingSliverList({required super.childManager, required this.hold});

  double Function(RenderSliverList list) hold;

  @override
  void performLayout() {
    super.performLayout();
    // The list asked for a correction of its own: it knows better.
    if (geometry!.scrollOffsetCorrection != null) return;
    final correction = hold(this);
    if (correction != 0) {
      geometry = SliverGeometry(scrollOffsetCorrection: correction);
    }
  }
}

/// Long Comments are clamped with a fade and a "Show more" toggle, like the web.
/// The decision is made during layout, so a Comment never shows at full height
/// for a frame and then shrinks.
///
/// The Timeline is reversed, so a box opening in place would push its top up
/// and out of view. Expanding and collapsing scroll by the same amount, on
/// every animation frame, keeping the top where it is, as on the web; opening
/// a box also stops the Timeline following new content. New text in an
/// expanded box is the Timeline's business: it holds whatever is on screen
/// still while content arrives below it.
class _Clamped extends StatefulWidget {
  final Widget child;

  /// The opaque color behind the text, faded over the clamped bottom.
  final Color fade;

  /// Opens the box, e.g. for the Comment that replaces a live box the reader
  /// had expanded.
  final bool expanded;
  final ValueChanged<bool>? onExpandedChanged;
  const _Clamped({
    super.key,
    required this.child,
    required this.fade,
    this.expanded = false,
    this.onExpandedChanged,
  });
  @override
  State<_Clamped> createState() => _ClampedState();
}

class _ClampedState extends State<_Clamped>
    with SingleTickerProviderStateMixin {
  late bool _expanded = widget.expanded;
  late final _expansion = AnimationController(
    vsync: this,
    duration: Motion.medium,
    value: _expanded ? 1 : 0,
  )..addListener(_keepTopWhileAnimating);
  late final _progress = CurvedAnimation(
    parent: _expansion,
    curve: Motion.enter,
  );
  late double _shown = _progress.value;

  @override
  void didUpdateWidget(_Clamped oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A Comment the live text was appended to is already on screen.
    if (widget.expanded && !oldWidget.expanded && !_expanded) {
      _expanded = true;
      _shown = 1;
      _expansion.value = 1;
    }
  }

  @override
  void dispose() {
    _progress.dispose();
    _expansion.dispose();
    super.dispose();
  }

  void _toggle() {
    setState(() => _expanded = !_expanded);
    widget.onExpandedChanged?.call(_expanded);
    if (MediaQuery.disableAnimationsOf(context)) {
      _expansion.value = _expanded ? 1 : 0;
    } else if (_expanded) {
      _expansion.forward();
    } else {
      _expansion.reverse();
    }
  }

  /// Runs on each animation tick, before layout, so the frame shows the box
  /// and the scroll offset in step.
  void _keepTopWhileAnimating() {
    final shown = _progress.value, change = shown - _shown;
    _shown = shown;
    final box = context.findRenderObject();
    if (change != 0 && box is _RenderClamp) {
      _scrollBy(box.hiddenHeight * change, always: true);
    }
  }

  /// [always] false leaves the Timeline following at the bottom.
  void _scrollBy(double delta, {required bool always}) {
    final position = Scrollable.maybeOf(context)?.position;
    if (position == null ||
        position.axisDirection != AxisDirection.up ||
        (!always && position.pixels < _followSlack)) {
      return;
    }
    final target = position.pixels + delta;
    position.jumpTo(
      target < position.minScrollExtent ? position.minScrollExtent : target,
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _progress,
    builder: (context, _) => _ClampLayout(
      progress: _progress.value,
      fade: widget.fade,
      content: widget.child,
      toggle: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Pressable(
          onTap: _toggle,
          pressedScale: .96,
          borderRadius: BorderRadius.circular(8),
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                _expanded
                    ? Icons.keyboard_arrow_up_rounded
                    : Icons.keyboard_arrow_down_rounded,
                size: 16,
                color: Palette.fgMuted,
              ),
              const SizedBox(width: 4),
              Text(
                _expanded ? 'Show less' : 'Show more',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: Palette.fgMuted,
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class _ClampLayout extends MultiChildRenderObjectWidget {
  final double progress;
  final Color fade;
  _ClampLayout({
    required this.progress,
    required this.fade,
    required Widget content,
    required Widget toggle,
  }) : super(children: [content, toggle]);
  @override
  _RenderClamp createRenderObject(BuildContext context) =>
      _RenderClamp(progress, fade);
  @override
  void updateRenderObject(BuildContext context, _RenderClamp renderObject) {
    renderObject
      ..progress = progress
      ..fade = fade;
  }
}

class _ClampParentData extends ContainerBoxParentData<RenderBox> {}

/// Lays out the content at full height; past [max] (+ some slack, so a line or
/// two isn't hidden) it shows [max] with a fade, and the toggle below it.
/// [progress] opens it from [max] (0) to the full height (1).
class _RenderClamp extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _ClampParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _ClampParentData> {
  static const max = 320.0, slack = 40.0, fadeHeight = 64.0;
  _RenderClamp(this._progress, this._fade);

  double _progress;
  set progress(double value) {
    if (value == _progress) return;
    _progress = value;
    markNeedsLayout();
  }

  Color _fade;
  set fade(Color value) {
    if (value == _fade) return;
    _fade = value;
    markNeedsPaint();
  }

  bool _overflowing = false;
  double _contentHeight = 0;

  /// What the clamp hides when closed.
  double get hiddenHeight => _overflowing ? _contentHeight - max : 0;
  double get _visible => max + hiddenHeight * _progress;
  bool get _clipped => _overflowing && _progress < 1;

  RenderBox get _content => firstChild!;
  RenderBox get _toggle => lastChild!;

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _ClampParentData) {
      child.parentData = _ClampParentData();
    }
  }

  Size _measure(BoxConstraints constraints, {required bool dry}) {
    final loose = BoxConstraints(maxWidth: constraints.maxWidth);
    final content = dry
        ? _content.getDryLayout(loose)
        : (_content..layout(loose, parentUsesSize: true)).size;
    final overflowing = content.height > max + slack;
    if (!dry) {
      _overflowing = overflowing;
      _contentHeight = content.height;
    }
    var width = content.width, height = content.height;
    if (overflowing) {
      final toggle = dry
          ? _toggle.getDryLayout(loose)
          : (_toggle..layout(loose, parentUsesSize: true)).size;
      height = max + (content.height - max) * _progress;
      if (!dry) {
        (_toggle.parentData as _ClampParentData).offset = Offset(0, height);
      }
      height += toggle.height;
      width = width > toggle.width ? width : toggle.width;
    } else if (!dry) {
      _toggle.layout(loose);
    }
    return constraints.constrain(Size(width, height));
  }

  @override
  void performLayout() {
    size = _measure(constraints, dry: false);
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) =>
      _measure(constraints, dry: true);

  @override
  double computeMinIntrinsicWidth(double height) =>
      _content.getMinIntrinsicWidth(height);
  @override
  double computeMaxIntrinsicWidth(double height) =>
      _content.getMaxIntrinsicWidth(height);

  @override
  void paint(PaintingContext context, Offset offset) {
    if (!_clipped) {
      context.paintChild(_content, offset);
    } else {
      final visible = offset & Size(size.width, _visible);
      context.pushClipRect(
        needsCompositing,
        offset,
        Offset.zero & Size(size.width, _visible),
        (context, offset) => context.paintChild(_content, offset),
      );
      final band = Rect.fromLTRB(
        visible.left,
        visible.bottom - fadeHeight,
        visible.right,
        visible.bottom,
      );
      // The fade lifts as the box opens.
      final fade = _fade.withValues(alpha: _fade.a * (1 - _progress));
      context.canvas.drawRect(
        band,
        Paint()
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [fade.withValues(alpha: 0), fade],
          ).createShader(band),
      );
    }
    if (_overflowing) {
      context.paintChild(
        _toggle,
        offset + (_toggle.parentData as _ClampParentData).offset,
      );
    }
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) {
    if (_overflowing &&
        result.addWithPaintOffset(
          offset: (_toggle.parentData as _ClampParentData).offset,
          position: position,
          hitTest: (result, transformed) =>
              _toggle.hitTest(result, position: transformed),
        )) {
      return true;
    }
    if (_clipped && position.dy > _visible) return false;
    return _content.hitTest(result, position: position);
  }
}

class _Delivery extends StatelessWidget {
  final Map delivery;
  const _Delivery({required this.delivery});
  @override
  Widget build(BuildContext context) {
    final state = delivery['state'] as String?;
    final reason = delivery['reason'] as String?;
    // Web DeliveryBadge colors.
    final (icon, color, label) = switch (state) {
      'delivered' => (
        Icons.check_circle_outline_rounded,
        Palette.success,
        'Delivered',
      ),
      'queued' => (Icons.schedule_rounded, Palette.info, 'Queued'),
      'not_delivered' => (
        Icons.do_not_disturb_alt_rounded,
        Palette.fgMuted,
        'Not delivered',
      ),
      _ => (Icons.circle_outlined, Palette.fgSubtle, '$state'),
    };
    return Tooltip(
      message: 'Delivery: $label${reason == null ? '' : ' · $reason'}',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: color),
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

  /// Draws the icon in a small ring, like the web Timeline's Revisions.
  final bool ringed;
  const _Meta({
    required this.icon,
    required this.child,
    this.color = Palette.fgSubtle,
    this.ringed = false,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 32,
          child: ringed
              ? Center(
                  child: Container(
                    width: 22,
                    height: 22,
                    decoration: BoxDecoration(
                      color: Palette.bg,
                      shape: BoxShape.circle,
                      border: Border.all(color: Palette.borderStrong),
                    ),
                    child: Icon(icon, size: 12, color: color),
                  ),
                )
              : Icon(icon, size: 15, color: color),
        ),
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
  final Color color;
  final Widget child;
  const _Collapsible({
    required this.icon,
    required this.title,
    required this.child,
    this.trailing,
    this.alert = false,
    this.color = Palette.fgMuted,
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
        borderRadius: BorderRadius.circular(Radii.md),
        border: Border.all(color: Palette.border),
      ),
      child: AnimatedSize(
        duration: Motion.medium,
        curve: Motion.enter,
        alignment: Alignment.topLeft,
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
                    color: widget.alert ? Palette.danger : widget.color,
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
                          color: widget.alert
                              ? Palette.danger
                              : Palette.fgSubtle,
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
      ],
    );
  }
}

/// A Run's trace on the Timeline: where it went and how it ended. What it did
/// lives in its sheet, because its transcript only exists while the Job runs.
class _RunTrace extends StatelessWidget {
  final TaskController controller;
  final Json run;
  const _RunTrace({required this.controller, required this.run});
  @override
  Widget build(BuildContext context) {
    final status = '${run['status']}', error = run['error'] as String?;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Pressable(
        key: Key('run:${run['id']}'),
        onTap: () => _openRunSheet(context, controller, run),
        pressedScale: 1,
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(width: 32, child: Center(child: _runLeading(run, 15))),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: '${run['description']}',
                          style: const TextStyle(
                            fontWeight: FontWeight.w500,
                            color: Palette.fg,
                          ),
                        ),
                        TextSpan(
                          text:
                              ' · ${_runStatusLabel(status)} · ${_runDuration(run, DateTime.now())} · ${_runCalls(run)}',
                        ),
                      ],
                    ),
                    style: const TextStyle(
                      fontSize: 12.5,
                      height: 1.4,
                      color: Palette.fgSubtle,
                    ),
                  ),
                  if (error != null && error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        error,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 12,
                          height: 1.35,
                          color: Palette.danger,
                        ),
                      ),
                    )
                  else if (run['outcome'] is String &&
                      (run['outcome'] as String).isNotEmpty)
                    // A Background Command reports how it ended.
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        run['outcome'] as String,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 12,
                          height: 1.35,
                          color: Palette.fgSubtle,
                        ),
                      ),
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

/// The Agent's Active Runs above the composer: what it is running now, then
/// the failures the reader hasn't closed.
class _ActiveRunsBar extends StatefulWidget {
  final TaskController controller;
  const _ActiveRunsBar({required this.controller});
  @override
  State<_ActiveRunsBar> createState() => _ActiveRunsBarState();
}

class _ActiveRunsBarState extends State<_ActiveRunsBar> {
  Timer? _clock;
  bool _ticking = false;
  @override
  void dispose() {
    _clock?.cancel();
    super.dispose();
  }

  /// A 1 s clock while something runs, so elapsed times grow by themselves.
  void _syncClock(bool active) {
    if (active == _ticking) return;
    _ticking = active;
    _clock?.cancel();
    _clock = active
        ? Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}))
        : null;
  }

  @override
  Widget build(BuildContext context) {
    final runs = widget.controller.runBar;
    _syncClock(runs.any((run) => run['status'] == 'running'));
    if (runs.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final run in runs)
            _RunChip(
              key: Key('run-chip:${run['id']}'),
              controller: widget.controller,
              run: run,
            ),
        ],
      ),
    );
  }
}

class _RunChip extends StatelessWidget {
  final TaskController controller;
  final Json run;
  const _RunChip({super.key, required this.controller, required this.run});
  @override
  Widget build(BuildContext context) {
    final failed = run['status'] == 'error';
    return Container(
      decoration: BoxDecoration(
        color: Palette.raised,
        borderRadius: BorderRadius.circular(99),
        border: Border.all(
          color: failed
              ? Palette.danger.withValues(alpha: .45)
              : Palette.border,
        ),
      ),
      padding: const EdgeInsets.fromLTRB(4, 1, 3, 1),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Pressable(
            onTap: () => _openRunSheet(context, controller, run),
            borderRadius: BorderRadius.circular(99),
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(_runTypeIcon(run), size: 13, color: Palette.fgSubtle),
                const SizedBox(width: 5),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 170),
                  child: Text(
                    '${run['description']}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: Palette.fg),
                  ),
                ),
                const SizedBox(width: 6),
                _RunStatusIcon('${run['status']}'),
                const SizedBox(width: 5),
                Text(
                  _runDuration(run, DateTime.now()),
                  style: const TextStyle(
                    fontSize: 11.5,
                    color: Palette.fgSubtle,
                  ),
                ),
                if ((run['toolCalls'] as num? ?? 0) > 0) ...[
                  const SizedBox(width: 5),
                  Text(
                    run['toolCalls'] == 1
                        ? '1 call'
                        : '${run['toolCalls']} calls',
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: Palette.fgSubtle,
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (failed)
            Pressable(
              key: Key('dismiss-run:${run['id']}'),
              onTap: () => controller.dismissRun('${run['id']}'),
              semanticLabel: 'Dismiss ${run['description']}',
              borderRadius: BorderRadius.circular(99),
              padding: const EdgeInsets.all(3),
              child: const Icon(
                Icons.close_rounded,
                size: 13,
                color: Palette.fgSubtle,
              ),
            ),
        ],
      ),
    );
  }
}

/// Opens the sheet of a Run, from its bar chip or its Timeline trace.
Future<void> _openRunSheet(
  BuildContext context,
  TaskController controller,
  Json run,
) async {
  final id = '${run['id']}';
  controller.openRun(id);
  await showAppSheet<void>(
    context,
    maxWidth: 620,
    builder: (_) => _RunSheet(controller: controller, runId: id, trace: run),
  );
  controller.closeRun();
}

/// What a Run did, live: its prompt, its statistics and its transcript.
class _RunSheet extends StatefulWidget {
  final TaskController controller;
  final String runId;

  /// The trace the reader tapped, which still names the Run once the Job ended.
  final Json trace;
  const _RunSheet({
    required this.controller,
    required this.runId,
    required this.trace,
  });
  @override
  State<_RunSheet> createState() => _RunSheetState();
}

class _RunSheetState extends State<_RunSheet> {
  final _scroll = ScrollController();

  /// The Runs opened here, nested ones included: the last one fills the sheet.
  final _path = <String>[];
  final _traces = <String, Json>{};
  bool _following = true, _ticking = false;
  Timer? _clock;
  int _shown = -1;

  String get _id => _path.isEmpty ? widget.runId : _path.last;

  @override
  void initState() {
    super.initState();
    _path.add(widget.runId);
    _traces[widget.runId] = widget.trace;
    _scroll.addListener(() {
      if (!_scroll.hasClients) return;
      final p = _scroll.position;
      _following = p.maxScrollExtent - p.pixels < 48;
    });
  }

  @override
  void dispose() {
    _clock?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  void _syncClock(bool active) {
    if (active == _ticking) return;
    _ticking = active;
    _clock?.cancel();
    _clock = active
        ? Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}))
        : null;
  }

  /// Follows the newest message while the reader stays at the bottom.
  void _follow(int messages) {
    if (messages == _shown) return;
    _shown = messages;
    if (!_following) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  /// A nested Subagent Run opens in place; the chevron goes back to its parent.
  void _open(String id) {
    widget.controller.openRun(id);
    setState(() {
      _path.add(id);
      _shown = -1;
      _following = true;
    });
  }

  void _back() {
    setState(() {
      if (_path.length > 1) _path.removeLast();
      _shown = -1;
      _following = true;
    });
  }

  Json _run(TaskController c) {
    final transcript = c.runTranscripts[_id];
    return {
      ...?_traces[_id],
      ...?c.runs[_id],
      if (transcript != null && transcript['run'] is Map)
        ...Map<String, dynamic>.from(transcript['run'] as Map),
    };
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final transcript = c.runTranscripts[_id];
      final run = _run(c);
      final messages = objects(transcript?['messages']);
      final prompt = transcript?['prompt'] as String?;
      final error = run['error'] as String?;
      // A Background Command reports how it ended: its outcome is the only trace of it.
      final outcome = error == null || error.isEmpty
          ? run['outcome'] as String?
          : null;
      _syncClock(run['status'] == 'running');
      _follow(messages.length);
      return SheetScaffold(
        scroll: false,
        title: '${run['description'] ?? 'Run'}',
        subtitle: run.isEmpty
            ? 'Loading…'
            : _runSummary(run, transcript?['usage']),
        headerActions: [
          if (_path.length > 1)
            IconAction(
              icon: Icons.arrow_upward_rounded,
              tooltip: 'Back to the parent Run',
              size: 34,
              onPressed: _back,
            ),
        ],
        body: Padding(
          padding: const EdgeInsets.fromLTRB(22, 4, 22, 18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (error != null && error.isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: Palette.danger.withValues(alpha: .08),
                    borderRadius: BorderRadius.circular(Radii.sm),
                    border: Border.all(
                      color: Palette.danger.withValues(alpha: .3),
                    ),
                  ),
                  child: SelectableText(
                    error,
                    style: const TextStyle(
                      fontSize: 12,
                      height: 1.4,
                      color: Palette.danger,
                    ),
                  ),
                ),
              if (outcome != null && outcome.isNotEmpty)
                Padding(
                  key: const Key('run-outcome'),
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Text(
                    outcome,
                    style: const TextStyle(
                      fontSize: 12,
                      height: 1.4,
                      color: Palette.fgMuted,
                    ),
                  ),
                ),
              if (prompt != null && prompt.isNotEmpty) ...[
                _Collapsible(
                  icon: Icons.notes_rounded,
                  title: 'Prompt',
                  child: SelectableText(
                    prompt,
                    style: const TextStyle(
                      fontSize: 12.5,
                      height: 1.45,
                      color: Palette.fgMuted,
                    ),
                  ),
                ),
                const SizedBox(height: 10),
              ],
              Flexible(
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: MediaQuery.sizeOf(context).height * .55,
                  ),
                  child: transcript == null
                      ? _RunNotice(
                          message: c.goneRuns.contains(_id)
                              ? 'This Run’s transcript is no longer in memory.'
                              : 'Loading…',
                        )
                      : messages.isEmpty
                      ? const _RunNotice(message: 'Nothing yet.')
                      : ListView.builder(
                          key: const Key('run-transcript'),
                          controller: _scroll,
                          shrinkWrap: true,
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          itemCount:
                              messages.length +
                              (transcript['truncated'] == true ? 1 : 0),
                          itemBuilder: (context, i) {
                            if (i == messages.length) {
                              return const Padding(
                                padding: EdgeInsets.only(top: 8),
                                child: Text(
                                  'The transcript reached its size limit, so older messages were dropped.',
                                  style: TextStyle(
                                    fontSize: 11,
                                    height: 1.4,
                                    fontStyle: FontStyle.italic,
                                    color: Palette.fgSubtle,
                                  ),
                                ),
                              );
                            }
                            return _RunMessageView(
                              key: ValueKey('run-message:${messages[i]['n']}'),
                              controller: c,
                              message: messages[i],
                              onOpenRun: _open,
                            );
                          },
                        ),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class _RunNotice extends StatelessWidget {
  final String message;
  const _RunNotice({required this.message});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: Text(
      message,
      style: const TextStyle(fontSize: 12.5, color: Palette.fgSubtle),
    ),
  );
}

/// One message of a Run's transcript: its own text, or a tool call it can expand.
class _RunMessageView extends StatefulWidget {
  final TaskController controller;
  final Json message;
  final void Function(String id) onOpenRun;
  const _RunMessageView({
    super.key,
    required this.controller,
    required this.message,
    required this.onOpenRun,
  });
  @override
  State<_RunMessageView> createState() => _RunMessageViewState();
}

class _RunMessageViewState extends State<_RunMessageView> {
  bool _open = false;
  @override
  Widget build(BuildContext context) {
    final m = widget.message;
    if (m['type'] == 'text') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Md('${m['text'] ?? ''}', size: 13.5, onLink: openLink),
      );
    }
    final status = '${m['status']}';
    final outcome = m['outcome'] as String?;
    final output = m['output'] as String?;
    final childRunId = m['childRunId'] is String
        ? m['childRunId'] as String
        : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Pressable(
          onTap: () => setState(() => _open = !_open),
          pressedScale: 1,
          borderRadius: BorderRadius.circular(Radii.sm),
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 5),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                _toolIcon('${m['name']}'),
                size: 14,
                color: Palette.fgSubtle,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text.rich(
                  TextSpan(children: _codeSpans('${m['summary']}')),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12.5,
                    height: 1.4,
                    color: Palette.fgMuted,
                  ),
                ),
              ),
              if (outcome != null && outcome.isNotEmpty) ...[
                const SizedBox(width: 6),
                Text(
                  outcome,
                  style: TextStyle(
                    fontFamily: mono,
                    fontSize: 10.5,
                    color: status == 'error'
                        ? Palette.danger
                        : Palette.fgSubtle,
                  ),
                ),
              ],
              const SizedBox(width: 6),
              _RunStatusIcon(status),
            ],
          ),
        ),
        if (childRunId != null)
          Align(
            alignment: Alignment.centerLeft,
            child: Pressable(
              key: Key('open-run:$childRunId'),
              onTap: () => widget.onOpenRun(childRunId),
              borderRadius: BorderRadius.circular(Radii.sm),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.hub_rounded, size: 11, color: Palette.fgSubtle),
                  SizedBox(width: 4),
                  Text(
                    'Open its Run',
                    style: TextStyle(fontSize: 11, color: Palette.fgSubtle),
                  ),
                ],
              ),
            ),
          ),
        if (_open) ...[
          _CodeBlock(title: 'Input', text: _pretty(m['input'])),
          if (output != null)
            _CodeBlock(
              title: 'Output',
              text: output.isEmpty ? '(empty)' : output,
            ),
        ],
      ],
    );
  }
}

class _CodeBlock extends StatelessWidget {
  final String title, text;
  const _CodeBlock({required this.title, required this.text});
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.fromLTRB(26, 4, 0, 8),
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: Palette.sidebar,
      borderRadius: BorderRadius.circular(Radii.sm),
      border: Border.all(color: Palette.border),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 10.5,
            letterSpacing: .4,
            fontWeight: FontWeight.w600,
            color: Palette.fgSubtle,
          ),
        ),
        const SizedBox(height: 4),
        SelectableText(
          text,
          maxLines: 14,
          style: const TextStyle(
            fontFamily: mono,
            fontSize: 11.5,
            height: 1.5,
            color: Palette.fgMuted,
          ),
        ),
      ],
    ),
  );
}

String _pretty(Object? value) {
  if (value == null) return '';
  try {
    return const JsonEncoder.withIndent('  ').convert(value);
  } catch (_) {
    return '$value';
  }
}

/// How long a Run took, or has been going.
String _runDuration(Json run, DateTime now) {
  final start = DateTime.tryParse('${run['startedAt']}');
  if (start == null) return '';
  final end = DateTime.tryParse('${run['finishedAt']}') ?? now;
  final s = end.difference(start).inSeconds;
  if (s < 60) return '${s}s';
  final m = s ~/ 60;
  return m < 60 ? '${m}m ${s % 60}s' : '${m ~/ 60}h ${m % 60}m';
}

String _runStatusLabel(String status) => switch (status) {
  'running' => 'running',
  'ok' => 'finished',
  'interrupted' => 'interrupted',
  _ => 'failed',
};

String _runCalls(Json run) {
  final calls = run['toolCalls'] as num? ?? 0;
  return calls == 1 ? '1 tool call' : '${calls.toInt()} tool calls';
}

/// Type, state, elapsed time and what it did, then its tokens when known.
String _runSummary(Json run, Object? usage) {
  final parts = [
    run['runType'] == 'command'
        ? 'Background command'
        : '${run['subagentType'] ?? 'Subagent'}',
    _runStatusLabel('${run['status']}'),
    _runDuration(run, DateTime.now()),
    _runCalls(run),
  ];
  if (usage is Map) {
    final tokens =
        (usage['inputTokens'] as num? ?? 0) +
        (usage['outputTokens'] as num? ?? 0) +
        (usage['cacheReadTokens'] as num? ?? 0) +
        (usage['cacheCreationTokens'] as num? ?? 0);
    parts.add(_tokens(tokens));
    parts.add(_cost(usage['costUsd']));
  }
  return parts.where((part) => part.isNotEmpty).join(' · ');
}

String _tokens(num n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M tokens';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k tokens';
  return '${n.toInt()} tokens';
}

String _cost(Object? usd) {
  if (usd is! num) return '';
  return usd < 0.01
      ? '\$${usd.toStringAsFixed(4)}'
      : '\$${usd.toStringAsFixed(2)}';
}

IconData _runTypeIcon(Json run) =>
    run['runType'] == 'command' ? Icons.terminal_rounded : Icons.hub_rounded;

/// What leads a Run's trace: a spinner while it runs, its type once it ended.
Widget _runLeading(Json run, double size) {
  final status = '${run['status']}';
  if (status == 'running') {
    return SizedBox(
      width: size,
      height: size,
      child: const CircularProgressIndicator(
        strokeWidth: 1.6,
        color: Palette.fgMuted,
      ),
    );
  }
  return Icon(
    _runTypeIcon(run),
    size: size,
    color: status == 'ok'
        ? Palette.success
        : status == 'error'
        ? Palette.danger
        : Palette.fgSubtle,
  );
}

class _RunStatusIcon extends StatelessWidget {
  static const size = 13.0;
  final String status;
  const _RunStatusIcon(this.status);
  @override
  Widget build(BuildContext context) => switch (status) {
    'running' || 'pending' => SizedBox(
      width: size,
      height: size,
      child: const CircularProgressIndicator(
        strokeWidth: 1.5,
        color: Palette.fgMuted,
      ),
    ),
    'ok' => Icon(
      Icons.check_circle_rounded,
      size: size,
      color: Palette.success,
    ),
    'interrupted' => Icon(
      Icons.remove_circle_outline_rounded,
      size: size,
      color: Palette.fgSubtle,
    ),
    _ => Icon(Icons.cancel_rounded, size: size, color: Palette.danger),
  };
}

IconData _toolIcon(String name) {
  if (name == 'Bash') return Icons.terminal_rounded;
  if (name == 'Read') return Icons.description_outlined;
  if (name == 'Edit' || name == 'MultiEdit' || name == 'Write') {
    return Icons.edit_note_rounded;
  }
  if (name == 'Grep' || name == 'Glob') return Icons.search_rounded;
  if (name == 'WebFetch' || name == 'WebSearch') return Icons.language_rounded;
  if (name == 'Task' || name == 'Agent') return Icons.hub_rounded;
  if (name.startsWith('mcp__')) return Icons.extension_rounded;
  return Icons.build_rounded;
}

/// Summaries mark inline code with backticks, like the web's Summary.
List<TextSpan> _codeSpans(String text) {
  final parts = text.split('`');
  return [
    for (var i = 0; i < parts.length; i++)
      if (parts[i].isNotEmpty)
        TextSpan(
          text: parts[i],
          style: i.isOdd
              ? const TextStyle(
                  fontFamily: mono,
                  fontSize: 11.5,
                  color: Palette.fg,
                )
              : null,
        ),
  ];
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

/// Height of one line of the composer: its buttons are centered on it.
const _composerLine = 48.0;

class Composer extends StatefulWidget {
  final TaskController controller;
  const Composer({super.key, required this.controller});
  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  bool _attaching = false;

  /// The time the draft is scheduled for; while set, Send reads "Schedule".
  DateTime? _dueAt;
  late final TextEditingController _text;
  final _focus = FocusNode();
  final _link = LayerLink();
  final _suggestions = OverlayPortalController();
  final _mentions = GlobalKey<MentionSuggestionsState>();
  @override
  void initState() {
    super.initState();
    _text = TextEditingController(text: widget.controller.draft.text);
    _focus.addListener(() => setState(() {}));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _suggestions.show();
    });
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
    _focus.dispose();
    super.dispose();
  }

  bool get _canSend {
    final c = widget.controller;
    return !c.sending && c.online && !c.draft.ambiguous;
  }

  Future<void> _send() async {
    if (!_canSend) return;
    final restoreFocus = _focus.hasFocus;
    final due = _dueAt;
    if (due != null) {
      final problem = scheduleProblem(due);
      if (problem != null) {
        toast(context, problem);
        return;
      }
      if (await widget.controller.scheduleDraft(due) && mounted) {
        setState(() => _dueAt = null);
      }
    } else {
      await perform(context, widget.controller.send);
    }
    if (mounted && restoreFocus) _focus.requestFocus();
  }

  KeyEventResult _handleComposerKey(FocusNode node, KeyEvent event) {
    if (_mentions.currentState?.handleKey(event) == true) {
      return KeyEventResult.handled;
    }
    if (event.logicalKey != LogicalKeyboardKey.enter &&
        event.logicalKey != LogicalKeyboardKey.numpadEnter) {
      return KeyEventResult.ignored;
    }
    final keyboard = HardwareKeyboard.instance;
    final composing = _text.value.composing;
    if (keyboard.isAltPressed ||
        (keyboard.isShiftPressed &&
            (keyboard.isControlPressed || keyboard.isMetaPressed)) ||
        (composing.isValid && !composing.isCollapsed)) {
      return KeyEventResult.ignored;
    }
    if (event is KeyRepeatEvent) return KeyEventResult.handled;
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (keyboard.isShiftPressed) {
      // Use the editor action to preserve selection, undo and draft updates.
      Actions.invoke(
        _focus.context!,
        ReplaceTextIntent(
          _text.value,
          '\n',
          _text.selection,
          SelectionChangedCause.keyboard,
        ),
      );
    } else {
      _send();
    }
    return KeyEventResult.handled;
  }

  Future<void> _pickDue() async {
    final due = await pickScheduleTime(context, initial: _dueAt);
    if (due != null && mounted) setState(() => _dueAt = due);
  }

  Future<void> _attach() async {
    setState(() => _attaching = true);
    try {
      await perform(context, () async {
        final c = widget.controller;
        final taskId = c.task?.id, client = c.api;
        final files = await pickAppAttachments(
          context,
          maxFiles: 10 - c.draft.files.length,
        );
        if (!mounted ||
            c.task?.id != taskId ||
            c.api != client ||
            files.isEmpty) {
          return;
        }
        final staged = <DraftFile>[];
        for (final file in files) {
          staged.add(await c.storage.stageAttachment(file));
        }
        if (!mounted || c.task?.id != taskId || c.api != client) return;
        await c.setDraft(
          c.draft.copyWith(files: [...c.draft.files, ...staged]),
        );
      });
    } finally {
      if (mounted) setState(() => _attaching = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, draft = widget.controller.draft;
    final internal = draft.internal;
    final sendForeground = internal ? Colors.white : Palette.onPrimary;
    // Internal chat looks like the web composer: dashed slate, never the accent.
    final line = internal
        ? Palette.slate.withValues(alpha: _focus.hasFocus ? .75 : .5)
        : _focus.hasFocus
        ? Palette.primary
        : Palette.borderStrong;
    final radius = BorderRadius.circular(Radii.xl);
    final due = _dueAt;
    final sendLabel = due != null
        ? 'Schedule'
        : internal
        ? 'Send to internal chat'
        : 'Send comment';
    // Buttons sit in fixed-height slots as tall as one line of text, so they
    // stay centered on it whatever the platform's font metrics, and stay on
    // the last line as the text grows.
    Widget slot(Widget child) => SizedBox(
      height: _composerLine,
      child: Center(child: child),
    );
    final box = AnimatedContainer(
      key: const Key('composer-box'),
      duration: Motion.medium,
      curve: Motion.enter,
      decoration: BoxDecoration(
        borderRadius: radius,
        // Always 1px, so switching to the dashed outline moves nothing.
        border: Border.all(color: internal ? Colors.transparent : line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (draft.files.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final file in draft.files)
                    FadeSlideIn(
                      key: ValueKey(file.path),
                      scale: .85,
                      offset: Offset.zero,
                      child: _DraftChip(
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
                    ),
                ],
              ),
            ),
          if (due != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 6, 0),
              child: Row(
                key: const Key('schedule-chip'),
                children: [
                  const Icon(
                    Icons.schedule_rounded,
                    size: 14,
                    color: Palette.primary,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      'Scheduled for ${formatDue(due)}',
                      style: const TextStyle(
                        fontSize: 12.5,
                        color: Palette.fgMuted,
                      ),
                    ),
                  ),
                  IconAction(
                    icon: Icons.close_rounded,
                    tooltip: 'Clear schedule',
                    size: 28,
                    onPressed: () => setState(() => _dueAt = null),
                  ),
                ],
              ),
            ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              const SizedBox(width: 6),
              slot(
                IconAction(
                  icon: Icons.attach_file_rounded,
                  tooltip: 'Attach local files',
                  size: 36,
                  onPressed: c.sending || _attaching ? null : _attach,
                ),
              ),
              slot(
                Semantics(
                  key: const Key('internal-toggle'),
                  toggled: internal,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: internal
                          ? Palette.slate.withValues(alpha: .12)
                          : Colors.transparent,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: IconAction(
                      icon: internal
                          ? Icons.lock_outline_rounded
                          : Icons.chat_bubble_outline_rounded,
                      tooltip: internal
                          ? 'Internal chat · switch to Comment'
                          : 'Comment · switch to Internal chat',
                      color: internal ? Palette.slate : Palette.fgSubtle,
                      size: 36,
                      onPressed: c.sending
                          ? null
                          : () => c.setDraft(
                              c.draft.copyWith(internal: !internal),
                            ),
                    ),
                  ),
                ),
              ),
              slot(
                IconAction(
                  key: const Key('schedule-button'),
                  icon: Icons.schedule_rounded,
                  tooltip: due == null
                      ? 'Schedule for later'
                      : 'Change scheduled time',
                  color: due == null ? Palette.fgSubtle : Palette.primary,
                  size: 36,
                  onPressed: c.sending ? null : _pickDue,
                ),
              ),
              Expanded(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: _composerLine),
                  // Desktop's compact density would trim the field's padding
                  // and lift the text off the buttons' center line.
                  child: Theme(
                    data: Theme.of(context)
                        .copyWith(visualDensity: VisualDensity.standard),
                    child: Focus(
                      onKeyEvent: _handleComposerKey,
                      child: TextField(
                        key: const Key('comment-composer'),
                        controller: _text,
                        focusNode: _focus,
                        enabled: !c.sending,
                        minLines: 1,
                        maxLines: 6,
                        maxLength: 100000,
                        keyboardType: TextInputType.multiline,
                        textInputAction: TextInputAction.send,
                        onEditingComplete: _text.clearComposing,
                        onSubmitted: (_) => _send(),
                        textCapitalization: TextCapitalization.sentences,
                        textAlignVertical: TextAlignVertical.center,
                        style: const TextStyle(fontSize: 15, height: 1.4),
                        // A fixed line height on every platform keeps one line
                        // exactly as tall as the button slots.
                        strutStyle: const StrutStyle(
                          fontSize: 15,
                          height: 1.4,
                          forceStrutHeight: true,
                        ),
                        decoration: InputDecoration(
                          hintText: internal
                              ? 'Hidden from the Agent…'
                              : c.task?.agentId == null
                              ? 'Leave a comment…'
                              : 'Message the Agent…',
                          // One line, so changing it never resizes the composer.
                          hintMaxLines: 1,
                          counterText: '',
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: (_composerLine - 15 * 1.4) / 2,
                          ),
                        ),
                        onChanged: (v) => c.setDraft(c.draft.copyWith(text: v)),
                      ),
                    ),
                  ),
                ),
              ),
              slot(
                Tooltip(
                  message: sendLabel,
                  child: AnimatedOpacity(
                    opacity: _canSend ? 1 : .4,
                    duration: Motion.fast,
                    child: Pressable(
                      key: const Key('send-comment'),
                      onTap: _canSend ? _send : null,
                      semanticLabel: sendLabel,
                      pressedScale: .88,
                      color: internal ? Palette.slateDeep : Palette.primary,
                      hoverColor: const Color(0x22ffffff),
                      borderRadius: BorderRadius.circular(99),
                      child: SizedBox(
                        height: 36,
                        width: due == null ? 36 : 104,
                        child: AnimatedSwitcher(
                          duration: Motion.fast,
                          transitionBuilder: (child, animation) =>
                              ScaleTransition(
                                scale: animation,
                                child: FadeTransition(
                                  opacity: animation,
                                  child: child,
                                ),
                              ),
                          child: c.sending
                              ? Padding(
                                  key: const ValueKey('sending'),
                                  padding: const EdgeInsets.all(10),
                                  child: Spinner(
                                    size: 16,
                                    color: sendForeground,
                                  ),
                                )
                              : due != null
                              ? Center(
                                  key: const ValueKey('schedule'),
                                  child: FittedBox(
                                    fit: BoxFit.scaleDown,
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(
                                          Icons.schedule_rounded,
                                          size: 16,
                                          color: sendForeground,
                                        ),
                                        const SizedBox(width: 5),
                                        Text(
                                          'Schedule',
                                          style: TextStyle(
                                            color: sendForeground,
                                            fontWeight: FontWeight.w600,
                                            fontSize: 13,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                )
                              : Icon(
                                  Icons.arrow_upward_rounded,
                                  key: const ValueKey('send'),
                                  size: 19,
                                  color: sendForeground,
                                ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
            ],
          ),
        ],
      ),
    );
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
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
            CompositedTransformTarget(
              link: _link,
              child: LayoutBuilder(
                builder: (context, constraints) => OverlayPortal(
                  controller: _suggestions,
                  // Over the conversation, like the web popover, so it never
                  // pushes the Timeline up.
                  overlayChildBuilder: (context) => Positioned(
                    width: constraints.maxWidth,
                    child: CompositedTransformFollower(
                      link: _link,
                      showWhenUnlinked: false,
                      targetAnchor: Alignment.topLeft,
                      followerAnchor: Alignment.bottomLeft,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          MentionSuggestions(
                            key: _mentions,
                            text: _text,
                            users: c.users,
                            onSelected: (value) =>
                                c.setDraft(c.draft.copyWith(text: value)),
                          ),
                          if (!internal)
                            SkillSuggestions(
                              text: _text,
                              skills: c.session?['commands'] is List
                                  ? objects(c.session?['commands'])
                                        .map(SkillCommand.fromJson)
                                        .toList()
                                  : c.agents
                                            .where(
                                              (a) => a.id == c.task?.agentId,
                                            )
                                            .firstOrNull
                                            ?.skillCommands ??
                                        [],
                              onSelected: (value) =>
                                  c.setDraft(c.draft.copyWith(text: value)),
                            ),
                        ],
                      ),
                    ),
                  ),
                  // Always wrapped, only its color changes: swapping the parent
                  // would rebuild the text field and drop its focus.
                  child: TweenAnimationBuilder<Color?>(
                    tween: ColorTween(
                      end: internal ? line : Colors.transparent,
                    ),
                    duration: Motion.medium,
                    builder: (context, color, child) => DashedOutline(
                      color: color ?? Colors.transparent,
                      borderRadius: radius,
                      child: child!,
                    ),
                    child: box,
                  ),
                ),
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
          const Icon(Icons.insert_drive_file_outlined, size: 14),
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
