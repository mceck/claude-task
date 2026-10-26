import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/task_forms.dart';
import 'package:fleather/fleather.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    for (final (family, files) in [
      (
        'Geist',
        ['Geist-Regular.ttf', 'Geist-Medium.ttf', 'Geist-SemiBold.ttf'],
      ),
      ('GeistMono', ['GeistMono-Regular.ttf']),
    ]) {
      final loader = FontLoader(family);
      for (final file in files) {
        loader.addFont(rootBundle.load('assets/fonts/$file'));
      }
      await loader.load();
    }
  });

  for (final (name, size) in [
    ('phone', const Size(390, 844)),
    ('desktop', const Size(1000, 900)),
  ]) {
    testWidgets('Task description layout on $name, with and without keyboard', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetViewInsets);
      final h = Harness();
      addTearDown(h.dispose);
      h.api.currentTask = {
        ...taskData(),
        'title': 'Make task descriptions easier to write',
        'description':
            '## Acceptance criteria\n\n'
            'Give every task **clear context** and a useful [reference](https://example.com).\n\n'
            '- [x] Match the app theme\n- [ ] Keep Markdown formatting\n\n'
            '```dart\nfinal task = await createTask();\n```',
      };
      await h.login();
      await h.openTask();
      const boundary = Key('editor-layout');
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: TaskApp(controller: h.controller),
        ),
      );
      await tester.pumpAndSettle();
      final editing = showEditTask(
        tester.element(find.byType(Scaffold).first),
        h.controller,
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(
        find.widgetWithText(TextButton, 'Markdown').hitTestable(),
        findsOneWidget,
      );
      // Include the settled dialog overlay in the captured layer.
      tester
          .renderObject<RenderRepaintBoundary>(find.byKey(boundary))
          .markNeedsPaint();
      await tester.pump();
      await expectLater(
        find.byKey(boundary),
        matchesGoldenFile('goldens/task_description_$name.png'),
      );
      await tester.ensureVisible(find.byType(FleatherEditor));
      await tester.tap(find.byType(FleatherEditor));
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      await tester.pumpAndSettle();
      expect(find.text('Save').last.hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('Cancel').last);
      await tester.pumpAndSettle();
      await editing;
      expect(tester.takeException(), isNull);
    });
  }
}
