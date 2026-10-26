import 'dart:async';
import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:open_filex/open_filex.dart';
import 'app.dart';
import 'controller.dart';
import 'models.dart';
import 'task_forms.dart';

class Conversation extends StatefulWidget {
  final TaskController controller;
  final VoidCallback? onBack;
  const Conversation({super.key, required this.controller, this.onBack});
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

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, t = widget.controller.task!;
    _afterContent();
    return Column(
      children: [
        SizedBox(
          height: 66,
          child: Row(
            children: [
              if (widget.onBack != null)
                IconButton(
                  onPressed: widget.onBack,
                  icon: const Icon(Icons.arrow_back),
                ),
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 16),
                child: Icon(Icons.tag, color: Color(0xffb5a9ff)),
              ),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      t.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      '${t.key} · ${c.session?['state'] ?? 'No Agent Session'}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: c.preference?.following == true
                    ? 'Unfollow Task'
                    : 'Follow Task',
                onPressed: c.online
                    ? () => perform(
                        context,
                        () => c.setPreference({
                          'following': c.preference?.following != true,
                        }),
                      )
                    : null,
                icon: Icon(
                  c.preference?.following == true
                      ? Icons.bookmark
                      : Icons.bookmark_outline,
                ),
              ),
              IconButton(
                tooltip: c.preference?.muted == true
                    ? 'Unmute Task'
                    : 'Mute Task',
                onPressed: c.online
                    ? () => perform(
                        context,
                        () => c.setPreference({
                          'muted': c.preference?.muted != true,
                        }),
                      )
                    : null,
                icon: Icon(
                  c.preference?.muted == true
                      ? Icons.notifications_off_outlined
                      : Icons.notifications_none,
                ),
              ),
              PopupMenuButton<String>(
                tooltip: 'Task actions',
                onSelected: (action) {
                  if (action == 'delete') {
                    confirmDeleteTask(context, c);
                  } else if (action == 'details') {
                    showDetails(context, c);
                  } else {
                    perform(context, () => c.sessionAction(action));
                  }
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(
                    value: 'details',
                    child: Text('Task details'),
                  ),
                  PopupMenuItem(
                    value: 'stop',
                    enabled: c.online && c.session != null,
                    child: const Text('Interrupt'),
                  ),
                  PopupMenuItem(
                    value: 'retry',
                    enabled: c.online && c.session != null,
                    child: const Text('Retry'),
                  ),
                  PopupMenuItem(
                    value: 'notify',
                    enabled: c.online && c.session != null,
                    child: const Text('Notify agent'),
                  ),
                  PopupMenuItem(
                    value: 'delete',
                    enabled: c.online,
                    child: const Text('Delete Task'),
                  ),
                ],
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        if (c.assignmentRetryId != null)
          Material(
            color: const Color(0xff4b3b1f),
            child: ListTile(
              dense: true,
              title: const Text('Task created. Agent assignment needs retry.'),
              trailing: TextButton(
                onPressed: c.online
                    ? () => perform(context, c.retryAssignment)
                    : null,
                child: const Text('Retry assignment'),
              ),
            ),
          ),
        Expanded(
          child: Stack(
            children: [
              Positioned.fill(
                child: c.timeline.isEmpty && c.liveText.isEmpty
                    ? const Center(
                        child: Text('Start the conversation with a Comment.'),
                      )
                    : ListView.builder(
                        key: const Key('timeline'),
                        controller: _scroll,
                        reverse: true,
                        padding: const EdgeInsets.all(20),
                        itemCount: c.timeline.length + 2,
                        itemBuilder: (context, index) {
                          if (index == 0) {
                            return Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                if (c.liveThinking.isNotEmpty)
                                  ExpansionTile(
                                    title: const Text('Thinking · streaming'),
                                    children: [
                                      Padding(
                                        padding: const EdgeInsets.all(16),
                                        child: SelectableText(c.liveThinking),
                                      ),
                                    ],
                                  ),
                                for (final text in c.liveText.values)
                                  Padding(
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 12,
                                    ),
                                    child: MarkdownBody(
                                      data: '$text ▍',
                                      onTapLink: (_, href, _) => openLink(href),
                                    ),
                                  ),
                                if (c.liveStatus.isNotEmpty)
                                  Text(
                                    c.liveStatus,
                                    style: const TextStyle(color: Colors.amber),
                                  ),
                              ],
                            );
                          }
                          if (index == c.timeline.length + 1) {
                            return c.nextCursor == null
                                ? const SizedBox(height: 12)
                                : Center(
                                    child: TextButton(
                                      onPressed: _loadingOlder || !c.online
                                          ? null
                                          : () async {
                                              setState(
                                                () => _loadingOlder = true,
                                              );
                                              await perform(
                                                context,
                                                c.loadOlder,
                                              );
                                              if (mounted) {
                                                setState(
                                                  () => _loadingOlder = false,
                                                );
                                              }
                                            },
                                      child: Text(
                                        _loadingOlder
                                            ? 'Loading…'
                                            : 'Load older entries',
                                      ),
                                    ),
                                  );
                          }
                          final entry = c.timeline[c.timeline.length - index];
                          return TimelineTile(
                            key: ValueKey(entry.id),
                            entry: entry,
                            controller: c,
                          );
                        },
                      ),
              ),
              if (!_atBottom)
                Positioned(
                  bottom: 12,
                  right: 16,
                  child: FilledButton.tonalIcon(
                    key: const Key('jump-latest'),
                    onPressed: () {
                      _scroll.animateTo(
                        0,
                        duration: const Duration(milliseconds: 220),
                        curve: Curves.easeOut,
                      );
                    },
                    icon: const Icon(Icons.arrow_downward, size: 16),
                    label: const Text('Jump to latest'),
                  ),
                ),
            ],
          ),
        ),
        const Divider(height: 1),
        Composer(key: ValueKey('composer:${t.id}'), controller: c),
      ],
    );
  }
}

class TimelineTile extends StatelessWidget {
  final TimelineEntry entry;
  final TaskController controller;
  const TimelineTile({
    super.key,
    required this.entry,
    required this.controller,
  });
  @override
  Widget build(BuildContext context) {
    final e = entry;
    if (e.type == 'revision') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.history, size: 16, color: Colors.grey),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                '${e.author} changed ${objects(e.content['changes']).map((v) => '${v['field']}: ${v['after']}').join(', ')}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ],
        ),
      );
    }
    if (e.type == 'agent') {
      final payload = e.payload, kind = e.payload['kind'];
      if (kind == 'thinking') {
        return ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: const Text('Thinking', style: TextStyle(fontSize: 13)),
          children: [SelectableText(payload['text'] as String? ?? '')],
        );
      }
      if (kind == 'activity') {
        return ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: const Text('Activity', style: TextStyle(fontSize: 13)),
          children: [
            for (final activity in objects(payload['entries']))
              _activity(activity),
          ],
        );
      }
      if (kind == 'turn_summary') {
        final summary = payload['summary'] as Map;
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Text(
            'Turn ${summary['isError'] == true ? 'failed' : 'completed'} · ${((summary['durationMs'] as num? ?? 0) / 1000).toStringAsFixed(1)}s · ${summary['toolCalls']} tool calls',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: summary['isError'] == true
                  ? Colors.redAccent
                  : Colors.grey,
            ),
          ),
        );
      }
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: SelectableText(payload['text'] as String? ?? ''),
      );
    }
    final delivery = e.content['delivery'] as Map?;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: e.internal ? const Color(0xff3b3226) : const Color(0xff24252e),
        borderRadius: BorderRadius.circular(10),
        border: e.internal ? Border.all(color: const Color(0xffa58142)) : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 13,
                child: Icon(
                  e.content['kind'] == 'agent'
                      ? Icons.smart_toy_outlined
                      : e.content['kind'] == 'system'
                      ? Icons.info_outline
                      : Icons.person_outline,
                  size: 16,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  e.author,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
              Text(
                _time(e.createdAt),
                style: Theme.of(context).textTheme.labelSmall,
              ),
              if (e.isOwnCommentEditable && e.authorId == controller.user?.id)
                PopupMenuButton<String>(
                  tooltip: 'Comment actions',
                  enabled: controller.online,
                  onSelected: (v) async {
                    if (v == 'delete') {
                      final accepted = await showDialog<bool>(
                        context: context,
                        builder: (dialog) => AlertDialog(
                          title: const Text('Delete Comment?'),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(dialog, false),
                              child: const Text('Cancel'),
                            ),
                            TextButton(
                              onPressed: () => Navigator.pop(dialog, true),
                              child: const Text('Delete'),
                            ),
                          ],
                        ),
                      );
                      if (accepted == true && context.mounted) {
                        await perform(
                          context,
                          () => controller.deleteComment(e.id),
                        );
                      }
                    } else {
                      final text = TextEditingController(text: e.body);
                      final edited = await showDialog<String>(
                        context: context,
                        builder: (dialog) => AlertDialog(
                          title: const Text('Edit Comment'),
                          content: TextField(
                            controller: text,
                            minLines: 3,
                            maxLines: 10,
                          ),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(dialog),
                              child: const Text('Cancel'),
                            ),
                            FilledButton(
                              onPressed: () => Navigator.pop(dialog, text.text),
                              child: const Text('Save'),
                            ),
                          ],
                        ),
                      );
                      if (edited != null && context.mounted) {
                        await perform(
                          context,
                          () => controller.editComment(e.id, edited),
                        );
                      }
                    }
                  },
                  itemBuilder: (_) => [
                    const PopupMenuItem(value: 'edit', child: Text('Edit')),
                    const PopupMenuItem(value: 'delete', child: Text('Delete')),
                  ],
                ),
            ],
          ),
          if (e.internal)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text(
                'INTERNAL NOTE · never delivered to the Agent',
                style: TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 11,
                  color: Color(0xffffcf83),
                ),
              ),
            ),
          const SizedBox(height: 10),
          e.deleted
              ? const Text(
                  'Comment deleted',
                  style: TextStyle(
                    fontStyle: FontStyle.italic,
                    color: Colors.grey,
                  ),
                )
              : MarkdownBody(
                  data: e.body,
                  selectable: true,
                  onTapLink: (_, href, _) => openLink(href),
                  imageBuilder: (uri, title, alt) =>
                      Text(alt ?? 'External image · open the link to view'),
                ),
          for (final attachment in e.attachments)
            AttachmentTile(attachment: attachment, controller: controller),
          if (e.content['editedAt'] != null)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'Edited',
                style: TextStyle(color: Colors.grey, fontSize: 11),
              ),
            ),
          if (delivery != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                'Delivery: ${delivery['state']}${delivery['reason'] == null ? '' : ' · ${delivery['reason']}'}',
                style: const TextStyle(fontSize: 11, color: Colors.grey),
              ),
            ),
        ],
      ),
    );
  }

  Widget _activity(Json item) => ExpansionTile(
    title: Text(
      '${item['name']} · ${item['summary']}',
      style: const TextStyle(fontSize: 12),
    ),
    subtitle: Text(
      '${item['status']}${item['outcome'] == null ? '' : ' · ${item['outcome']}'}',
    ),
    children: [
      Padding(
        padding: const EdgeInsets.all(12),
        child: SelectableText(
          '${item['input']}\n${item['output'] ?? ''}',
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
        ),
      ),
      for (final child in objects(item['children'])) _activity(child),
    ],
  );
  String _time(DateTime date) {
    final d = date.toLocal();
    return '${d.day}/${d.month} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (image && _file != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 240),
              child: Image.file(
                _file!,
                errorBuilder: (_, _, _) =>
                    const Text('Image preview unavailable'),
              ),
            ),
          ),
        TextButton.icon(
          onPressed: _busy
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
          icon: Icon(_file != null ? Icons.download_done : Icons.attachment),
          label: Text(
            '${widget.attachment['filename']} · ${_file != null ? 'Downloaded' : 'Download'}',
          ),
        ),
      ],
    );
  }
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

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, draft = widget.controller.draft;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      color: draft.internal ? const Color(0xff302a21) : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (draft.ambiguous)
            Row(
              children: [
                const Expanded(
                  child: Text(
                    'Send outcome unknown. Check the refreshed conversation.',
                  ),
                ),
                TextButton(
                  onPressed: c.online
                      ? () => perform(context, c.reconcileSend)
                      : null,
                  child: const Text('Refresh and review'),
                ),
              ],
            ),
          Row(
            children: [
              Switch(
                value: draft.internal,
                onChanged: c.sending
                    ? null
                    : (v) => c.setDraft(c.draft.copyWith(internal: v)),
              ),
              Expanded(
                child: Text(
                  draft.internal
                      ? 'Internal Note · never delivered to the Agent'
                      : 'Comment',
                  style: TextStyle(
                    fontSize: 12,
                    color: draft.internal
                        ? const Color(0xffffcf83)
                        : Colors.grey,
                  ),
                ),
              ),
              if (!c.online)
                const Text(
                  'Draft saved offline',
                  style: TextStyle(fontSize: 11, color: Colors.amber),
                ),
            ],
          ),
          for (final file in draft.files)
            Row(
              children: [
                const Icon(Icons.attach_file, size: 16),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '${file.name} · local, not uploaded',
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
                IconButton(
                  tooltip: 'Remove attachment',
                  onPressed: c.sending
                      ? null
                      : () => c.setDraft(
                          draft.copyWith(
                            files: draft.files.where((f) => f != file).toList(),
                          ),
                        ),
                  icon: const Icon(Icons.close, size: 16),
                ),
              ],
            ),
          TextField(
            key: const Key('comment-composer'),
            controller: _text,
            enabled: !c.sending,
            minLines: 1,
            maxLines: 6,
            maxLength: 100000,
            decoration: InputDecoration(
              hintText: draft.internal
                  ? 'Write an Internal Note…'
                  : 'Write a Comment…',
              counterText: '',
              isDense: true,
            ),
            onChanged: (v) => c.setDraft(c.draft.copyWith(text: v)),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              IconButton(
                tooltip: 'Attach local files',
                onPressed: c.sending
                    ? null
                    : () => perform(context, () async {
                        final result = await FilePicker.pickFiles();
                        if (result.isEmpty) return;
                        final files = result
                            .where((f) => f.path != null)
                            .map((f) => DraftFile(f.path!, f.name))
                            .toList();
                        if (c.draft.files.length + files.length > 10 ||
                            result.any(
                              (f) => (f.lengthSync() ?? 0) > 25 * 1024 * 1024,
                            )) {
                          throw StateError('At most 10 files, 25 MB each');
                        }
                        final staged = <DraftFile>[];
                        for (final file in files) {
                          staged.add(await c.storage.stageAttachment(file));
                        }
                        await c.setDraft(
                          c.draft.copyWith(
                            files: [...c.draft.files, ...staged],
                          ),
                        );
                      }),
                icon: const Icon(Icons.add_circle_outline),
              ),
              const Spacer(),
              FilledButton.icon(
                key: const Key('send-comment'),
                onPressed: c.sending || !c.online || draft.ambiguous
                    ? null
                    : () => perform(context, c.send),
                icon: Icon(
                  draft.internal ? Icons.lock_outline : Icons.send,
                  size: 16,
                ),
                label: Text(
                  c.sending
                      ? 'Sending…'
                      : draft.internal
                      ? 'Post Internal Note'
                      : 'Send',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
