import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'controller.dart';
import 'models.dart';
import 'voice.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

class TaskVoiceRoom extends StatefulWidget {
  final TaskController controller;
  final Task task;
  const TaskVoiceRoom({
    super.key,
    required this.controller,
    required this.task,
  });
  @override
  State<TaskVoiceRoom> createState() => _TaskVoiceRoomState();
}

class _TaskVoiceRoomState extends State<TaskVoiceRoom> {
  bool _wasOnline = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    _wasOnline = widget.controller.online;
    unawaited(_load());
  }

  @override
  void didUpdateWidget(TaskVoiceRoom oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.task.id != oldWidget.task.id ||
        (!_wasOnline && widget.controller.online)) {
      unawaited(_load());
    }
    _wasOnline = widget.controller.online;
  }

  Future<void> _load() async {
    final c = widget.controller, id = widget.task.id;
    final api = c.api;
    final previous = c.voice.rooms[id];
    try {
      final response = await api!.request('GET', '/tasks/$id/voice');
      if (!mounted ||
          widget.task.id != id ||
          !identical(c.api, api) ||
          c.user == null) {
        return;
      }
      if (identical(c.voice.rooms[id], previous)) {
        c.voice.observe(Map<String, dynamic>.from(response['room'] as Map));
      }
      setState(() {
        _error = null;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = 'Room unavailable';
        });
      }
    }
  }

  Future<void> _join() async {
    final v = widget.controller.voice;
    String? replace = v.participantId;
    if (replace != null &&
        !await confirm(
          context,
          title: 'Transfer voice participation?',
          message: 'Leave ${v.room?['taskKey']} and join ${widget.task.key}?',
          confirmLabel: 'Transfer',
          destructive: false,
        )) {
      return;
    }
    if (!mounted) return;
    try {
      await v.join(widget.task.id, widget.task.key, replace: replace);
    } on VoiceTransfer catch (e) {
      if (!mounted) return;
      if (!await confirm(
        context,
        title: 'Transfer voice participation?',
        message: 'You are in ${e.taskKey} on another device. Move voice here?',
        confirmLabel: 'Transfer',
        destructive: false,
      )) {
        return;
      }
      replace = e.participantId;
      try {
        await v.join(widget.task.id, widget.task.key, replace: replace);
      } catch (_) {
        /* The persistent controls display the failure. */
      }
    } catch (_) {
      /* The persistent controls display the failure. */
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller.voice,
    builder: (context, _) {
      final v = widget.controller.voice;
      final room = v.rooms[widget.task.id];
      final participants = room?['participants'] as List? ?? [];
      final active = v.room?['taskId'] == widget.task.id;
      return Container(
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: Palette.border)),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(
          children: [
            const Icon(
              Icons.headphones_rounded,
              size: 16,
              color: Palette.fgSubtle,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Voice Room · ${participants.length}/6',
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    _error ??
                        (participants.isEmpty
                            ? 'Join to talk about this Task'
                            : participants
                                  .map((p) => (p as Map)['user']['displayName'])
                                  .join(', ')),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 11,
                      color: Palette.fgSubtle,
                    ),
                  ),
                ],
              ),
            ),
            AppButton(
              label: active ? 'In voice' : 'Join voice',
              compact: true,
              tone: Tone.secondary,
              busy: v.joining,
              onPressed: !active && widget.controller.online ? _join : null,
            ),
          ],
        ),
      );
    },
  );
}

class VoiceControls extends StatelessWidget {
  final VoiceController voice;
  final VoidCallback? onOpenTask;
  const VoiceControls({super.key, required this.voice, this.onOpenTask});
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: voice,
    builder: (context, _) {
      final v = voice;
      if (v.room == null && !v.joining && v.error == null) {
        return const SizedBox.shrink();
      }
      return Container(
        padding: const EdgeInsets.all(12),
        decoration: const BoxDecoration(
          color: Palette.raised,
          border: Border(top: BorderSide(color: Palette.border)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (v.error != null)
              Notice(
                icon: Icons.error_outline_rounded,
                message: v.error!,
                onClose: v.dismissError,
              ),
            if (v.joining)
              const Padding(
                padding: EdgeInsets.all(4),
                child: Text(
                  'Joining Voice Room…',
                  style: TextStyle(fontSize: 12),
                ),
              ),
            if (v.room != null) ...[
              Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  AppButton(
                    label: 'Voice · ${v.room!['taskKey']}',
                    compact: true,
                    tone: Tone.secondary,
                    onPressed: onOpenTask,
                  ),
                  AppButton(
                    label: v.muted ? 'Unmute' : 'Mute',
                    icon: v.muted ? Icons.mic_off_rounded : Icons.mic_rounded,
                    compact: true,
                    tone: Tone.secondary,
                    onPressed: v.mute,
                  ),
                  AppButton(
                    label: v.deafened ? 'Listen' : 'Silence',
                    icon: v.deafened
                        ? Icons.headset_off_rounded
                        : Icons.headphones_rounded,
                    compact: true,
                    tone: Tone.secondary,
                    onPressed: v.deafen,
                  ),
                  AppButton(
                    label: 'Leave voice',
                    icon: Icons.call_end_rounded,
                    compact: true,
                    tone: Tone.danger,
                    onPressed: v.leave,
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 12,
                runSpacing: 6,
                children: [
                  for (final raw in v.room!['participants'] as List)
                    _Participant(
                      participant: Map<String, dynamic>.from(raw as Map),
                      voice: v,
                    ),
                ],
              ),
              if (v.links.containsValue('unavailable'))
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text(
                    'Some people cannot hear you. Retry or try another network to restore audio.',
                    style: TextStyle(color: Palette.danger, fontSize: 11),
                  ),
                ),
            ],
          ],
        ),
      );
    },
  );
}

class _Participant extends StatelessWidget {
  final Json participant;
  final VoiceController voice;
  const _Participant({required this.participant, required this.voice});
  @override
  Widget build(BuildContext context) {
    final id = participant['id'] as String;
    final self = id == voice.participantId;
    final status = voice.links[id] ?? 'connecting';
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          participant['muted'] == true
              ? Icons.mic_off_rounded
              : Icons.mic_rounded,
          size: 12,
          color: Palette.fgSubtle,
        ),
        const SizedBox(width: 4),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 160),
          child: Text(
            '${participant['user']['displayName']}${self ? ' (you)' : ''}',
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11),
          ),
        ),
        if (!self) ...[
          const SizedBox(width: 4),
          Text(
            status,
            style: TextStyle(
              fontSize: 10,
              color: status == 'unavailable'
                  ? Palette.danger
                  : Palette.fgSubtle,
            ),
          ),
          if (status == 'unavailable')
            IconButton(
              tooltip:
                  'Retry connection to ${participant['user']['displayName']}',
              onPressed: () => voice.retry(id),
              icon: const Icon(Icons.refresh_rounded, size: 16),
            ),
        ],
      ],
    );
  }
}
