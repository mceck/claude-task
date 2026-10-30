import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/task_forms.dart';
import 'package:claude_task_mobile/src/ui/theme.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

void main() {
  test('the controller loads every file of the Task and caches it', () async {
    final h = Harness();
    addTearDown(h.dispose);
    h.api.attachments = [
      taskAttachmentData(
        'file-1',
        filename: 'shot.png',
        contentType: 'image/png',
        size: 2048,
        author: mia,
        createdAt: at('2'),
      ),
      taskAttachmentData('file-2', filename: 'spec.txt', createdAt: at('1')),
    ];
    await h.login();
    await h.openTask();

    expect(h.controller.attachments.map((file) => file['filename']), [
      'shot.png',
      'spec.txt',
    ]);
    // Kept for the offline Task details.
    expect(
      (h.storage.read('task:task-1')!['attachments'] as List)
          .map((file) => (file as Json)['filename']),
      ['shot.png', 'spec.txt'],
    );
  });

  testWidgets('Task details lists the attachments under the description', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness();
    addTearDown(h.dispose);
    h.api.attachments = [
      taskAttachmentData(
        'file-1',
        filename: 'shot.png',
        contentType: 'image/png',
        size: 2048,
        author: mia,
        createdAt: at('2'),
      ),
      taskAttachmentData('file-2', filename: 'spec.txt', createdAt: at('1')),
    ];
    await h.login();
    await h.openTask();

    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(),
        home: Scaffold(body: TaskDetails(controller: h.controller)),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('ATTACHMENTS (2)'), findsOneWidget);
    expect(find.text('shot.png'), findsOneWidget);
    expect(find.text('spec.txt'), findsOneWidget);
    // Who posted the file, or that it belongs to the description.
    expect(find.textContaining('by Mia'), findsOneWidget);
    expect(find.textContaining('Description'), findsWidgets);
  });
}
