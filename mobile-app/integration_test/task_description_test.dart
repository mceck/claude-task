import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/task_forms.dart';
import 'package:fleather/fleather.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/support.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'native task description editing saves Markdown and cancels cleanly',
    (tester) async {
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.openTask();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      final context = tester.element(find.byType(Scaffold).first);
      final editing = showEditTask(context, h.controller);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Markdown'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('description-markdown-source')),
        '## Acceptance\n\n- [x] Preserve formatting\n- [ ] Ship the editor',
      );
      await tester.tap(find.text('Write'));
      await tester.pumpAndSettle();
      final rich = tester
          .widget<FleatherEditor>(find.byType(FleatherEditor))
          .controller;
      rich.updateSelection(
        const TextSelection(baseOffset: 0, extentOffset: 10),
      );
      await tester.pump();
      await tester.tap(find.byTooltip('Bold'));
      await tester.pumpAndSettle();
      rich.updateSelection(
        TextSelection.collapsed(offset: rich.document.length - 1),
      );
      await tester.drag(find.byTooltip('Bold'), const Offset(-500, 0));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Insert block'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Code block'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, 'dart, typescript, sql…'),
        'dart',
      );
      await tester.enterText(
        find.byKey(const Key('description-code')),
        'final ready = true;',
      );
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save').last);
      await tester.pumpAndSettle();
      await editing;
      final saved = h.api.currentTask['description'] as String;
      expect(saved, contains('## **Acceptance**'));
      expect(saved, contains('- [x] Preserve formatting'));
      expect(saved, contains('```dart\nfinal ready = true;\n```'));

      final cancelling = showEditTask(context, h.controller);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Markdown'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('description-markdown-source')),
        'Discard this edit',
      );
      await tester.tap(find.text('Cancel').last);
      await tester.pumpAndSettle();
      await cancelling;
      expect(h.api.currentTask['description'], saved);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
