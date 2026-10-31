import 'dart:io';

import 'package:claude_task_mobile/src/alerts.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _data(
  String text, {
  String taskId = 'task-1',
  String title = 'API-42 · Fix login',
}) => {
  'taskId': taskId,
  'eventId': 'turn:job:$text',
  'kind': 'turn.completed',
  'title': title,
  'sender': 'Opus',
  'senderKind': 'agent',
  'text': text,
};

void main() {
  late Directory dir;
  late AlertLines lines;
  setUp(() {
    dir = Directory.systemTemp.createTempSync('alerts');
    lines = AlertLines(() async => File('${dir.path}/alerts.json'));
  });
  tearDown(() => dir.deleteSync(recursive: true));

  test('reads an Alert from push data, and ignores data without one', () {
    final alert = PushAlertData.fromData(_data('Tests are green.'))!;
    expect(alert.taskId, 'task-1');
    expect(alert.title, 'API-42 · Fix login');
    expect(alert.sender, 'Opus');
    expect(alert.fromAgent, isTrue);
    expect(alert.body, 'Opus: Tests are green.');
    expect(PushAlertData.fromData({'taskId': 'task-1'}), isNull);
    final schedule = PushAlertData.fromData({
      ..._data('Schedule "Nightly": keeps being skipped', taskId: ''),
      'eventId': 'schedule-blocked:run-1',
      'sender': '',
      'senderKind': '',
    })!;
    expect(schedule.sender, isNull);
    expect(schedule.body, 'Schedule "Nightly": keeps being skipped');
    expect(schedule.thread, 'schedule-blocked:run-1');
  });

  test(
    'stacks the Alerts of one Task as lines, keeping the last five',
    () async {
      for (var i = 1; i <= 7; i++) {
        await lines.add(PushAlertData.fromData(_data('Line $i'))!);
      }
      final other = await lines.add(
        PushAlertData.fromData(
          _data('Elsewhere', taskId: 'task-2', title: 'API-43 · Other'),
        )!,
      );
      expect(other.lines.map((l) => l.text), ['Elsewhere']);
      final alert = await lines.add(
        PushAlertData.fromData(_data('Line 8', title: 'API-42 · Renamed'))!,
      );
      expect(alert.title, 'API-42 · Renamed');
      expect(alert.lines.map((l) => l.text), [
        'Line 4',
        'Line 5',
        'Line 6',
        'Line 7',
        'Line 8',
      ]);
      expect(alert.lines.last.sender, 'Opus');
    },
  );

  test('starts a fresh conversation once its notification is gone, and clears a Task', () async {
    await lines.add(PushAlertData.fromData(_data('Old'))!);
    final fresh = await lines.add(
      PushAlertData.fromData(_data('New'))!,
      fresh: true,
    );
    expect(fresh.lines.map((l) => l.text), ['New']);
    await lines.add(PushAlertData.fromData(_data('Other', taskId: 'task-2'))!);
    await lines.clear('task-1');
    final after = await lines.add(PushAlertData.fromData(_data('After'))!);
    expect(after.lines.map((l) => l.text), ['After']);
    expect(
      (await lines.add(
        PushAlertData.fromData(_data('More', taskId: 'task-2'))!,
      )).lines,
      hasLength(2),
    );
  });

  test('survives a damaged store', () async {
    File('${dir.path}/alerts.json').writeAsStringSync('not json');
    final alert = await lines.add(PushAlertData.fromData(_data('Hello'))!);
    expect(alert.lines.map((l) => l.text), ['Hello']);
  });

  test('gives every Task a stable notification id', () {
    expect(alertNotificationId('task-1'), alertNotificationId('task-1'));
    expect(alertNotificationId('task-1'), isNot(alertNotificationId('task-2')));
    expect(alertNotificationId('task-1'), greaterThan(0));
    expect(alertNotificationId('task-1'), lessThan(1 << 31));
  });

  test(
    'shows an Alert in the foreground unless its conversation is on screen',
    () {
      expect(
        showInForeground('task-1', watching: (id) => id == 'task-1'),
        isFalse,
      );
      expect(
        showInForeground('task-2', watching: (id) => id == 'task-1'),
        isTrue,
      );
      expect(showInForeground('task-1', watching: null), isTrue);
    },
  );

  test('initials for the sender avatar', () {
    expect(initials('Ada Lovelace'), 'AL');
    expect(initials('opus'), 'O');
    expect(initials('  '), '?');
    expect(initials('Grace Brewster Hopper'), 'GH');
  });
}
