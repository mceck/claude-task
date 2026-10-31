import 'dart:convert';
import 'dart:io';

/// The lines kept per Task in its conversation notification.
const maxAlertLines = 5;

/// One Alert as the backend sends it (docs/specs/conversation.md#alert-content).
class PushAlertData {
  final String taskId, eventId, kind, title, text;

  /// The Agent or User it is from; null for Schedule Alerts.
  final String? sender;
  final bool fromAgent;
  const PushAlertData({
    required this.taskId,
    required this.eventId,
    required this.kind,
    required this.title,
    required this.text,
    this.sender,
    this.fromAgent = false,
  });

  static PushAlertData? fromData(Map<String, dynamic> data) {
    final title = data['title'], text = data['text'];
    if (title is! String || text is! String || title.isEmpty) return null;
    final sender = data['sender'];
    return PushAlertData(
      taskId: data['taskId'] as String? ?? '',
      eventId: data['eventId'] as String? ?? '',
      kind: data['kind'] as String? ?? '',
      title: title,
      text: text,
      sender: sender is String && sender.isNotEmpty ? sender : null,
      fromAgent: data['senderKind'] == 'agent',
    );
  }

  /// One notification conversation per Task; a Schedule Alert without one has its own.
  String get thread => taskId.isNotEmpty ? taskId : eventId;

  /// The text of a single-line notification.
  String get body => sender == null ? text : '$sender: $text';
}

class AlertLine {
  final String? sender;
  final bool fromAgent;
  final String text;
  final DateTime at;
  const AlertLine({
    required this.sender,
    required this.fromAgent,
    required this.text,
    required this.at,
  });

  Map<String, dynamic> toJson() => {
    'sender': sender,
    'fromAgent': fromAgent,
    'text': text,
    'at': at.millisecondsSinceEpoch,
  };

  static AlertLine fromJson(Map<String, dynamic> json) => AlertLine(
    sender: json['sender'] as String?,
    fromAgent: json['fromAgent'] == true,
    text: json['text'] as String? ?? '',
    at: DateTime.fromMillisecondsSinceEpoch((json['at'] as num?)?.toInt() ?? 0),
  );
}

/// What one Task's conversation notification shows.
class TaskAlert {
  final String thread, title;
  final List<AlertLine> lines;
  const TaskAlert(this.thread, this.title, this.lines);
}

/// The recent lines of every Task with a notification on screen, kept in a file
/// so the foreground and background handlers rebuild the same conversation.
class AlertLines {
  final Future<File> Function() file;
  AlertLines(this.file);

  Future<Map<String, dynamic>> _read() async {
    try {
      final f = await file();
      if (!await f.exists()) return {};
      final decoded = jsonDecode(await f.readAsString());
      return decoded is Map<String, dynamic> ? decoded : {};
    } catch (_) {
      return {};
    }
  }

  Future<void> _write(Map<String, dynamic> all) async {
    final f = await file();
    await f.parent.create(recursive: true);
    await f.writeAsString(jsonEncode(all));
  }

  /// Adds an Alert to its Task's conversation; [fresh] starts it over, for a
  /// notification the User dismissed.
  Future<TaskAlert> add(
    PushAlertData alert, {
    bool fresh = false,
    DateTime? now,
  }) async {
    final all = await _read();
    final stored = all[alert.thread];
    final previous = fresh || stored is! Map
        ? <AlertLine>[]
        : [
            for (final line in (stored['lines'] as List? ?? const []))
              if (line is Map<String, dynamic>) AlertLine.fromJson(line),
          ];
    final lines = [
      ...previous,
      AlertLine(
        sender: alert.sender,
        fromAgent: alert.fromAgent,
        text: alert.text,
        at: now ?? DateTime.now(),
      ),
    ];
    final kept = lines.length > maxAlertLines
        ? lines.sublist(lines.length - maxAlertLines)
        : lines;
    all[alert.thread] = {
      'title': alert.title,
      'lines': [for (final line in kept) line.toJson()],
    };
    await _write(all);
    return TaskAlert(alert.thread, alert.title, kept);
  }

  Future<void> clear(String thread) async {
    final all = await _read();
    if (all.remove(thread) != null) await _write(all);
  }
}

/// A stable, positive 31-bit notification id per Task (FNV-1a).
int alertNotificationId(String thread) {
  var hash = 0x811c9dc5;
  for (final unit in utf8.encode(thread)) {
    hash = ((hash ^ unit) * 0x01000193) & 0xffffffff;
  }
  final id = hash & 0x7fffffff;
  // 0 is the group summary.
  return id == 0 ? 1 : id;
}

/// With the app open, an Alert appears unless its Task's conversation is on screen.
bool showInForeground(
  String taskId, {
  bool Function(String taskId)? watching,
}) => !(watching?.call(taskId) ?? false);

/// Up to two initials for an avatar drawn without its image.
String initials(String name) {
  final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
  if (words.isEmpty) return '?';
  final first = words.first, last = words.length > 1 ? words.last : null;
  return (first.substring(0, 1) + (last?.substring(0, 1) ?? '')).toUpperCase();
}
