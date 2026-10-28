import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/mention_suggestions.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

void main() {
  testWidgets('filters active Users and replaces only the token at the caret', (
    tester,
  ) async {
    final text = TextEditingController();
    addTearDown(text.dispose);
    final users = [
      User.fromJson({
        'id': 'mia',
        'displayName': 'Mia [QA]',
        'email': 'mia@example.com',
      }),
      User.fromJson({
        'id': 'ada',
        'displayName': 'Ada',
        'email': 'ada@example.com',
      }),
      User.fromJson({'id': 'old', 'displayName': 'Mia Old', 'active': false}),
    ];
    String? selected;
    final key = GlobalKey<MentionSuggestionsState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MentionSuggestions(
            key: key,
            text: text,
            users: users,
            onSelected: (value) => selected = value,
          ),
        ),
      ),
    );
    text.value = const TextEditingValue(
      text: 'Please @mi later',
      selection: TextSelection.collapsed(offset: 10),
    );
    await tester.pump();
    expect(find.text('@Mia [QA]'), findsOneWidget);
    expect(find.text('@Ada'), findsNothing);
    expect(find.text('@Mia Old'), findsNothing);
    await tester.tap(find.text('@Mia [QA]'));
    await tester.pump();
    expect(selected, r'Please [@Mia \[QA\]](/users/mia)  later');
    expect(text.selection.baseOffset, text.text.indexOf('  later') + 1);
    text.value = const TextEditingValue(
      text: 'mia@example.com',
      selection: TextSelection.collapsed(offset: 15),
    );
    await tester.pump();
    expect(find.text('@Mia [QA]'), findsNothing);
    text.value = const TextEditingValue(
      text: '@ada@example',
      selection: TextSelection.collapsed(offset: 12),
    );
    await tester.pump();
    expect(find.text('@Ada'), findsNothing);
    text.value = const TextEditingValue(
      text: '@example.com',
      selection: TextSelection.collapsed(offset: 12),
    );
    await tester.pump();
    expect(find.text('@Ada'), findsOneWidget);
    expect(
      key.currentState!.handleKey(
        const KeyDownEvent(
          logicalKey: LogicalKeyboardKey.escape,
          physicalKey: PhysicalKeyboardKey.escape,
          timeStamp: Duration.zero,
        ),
      ),
      isTrue,
    );
    await tester.pump();
    expect(find.text('@Ada'), findsNothing);
  });

  testWidgets(
    'Composer offers User mentions in Internal Notes and selects before sending',
    (tester) async {
      tester.view.physicalSize = const Size(1600, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.openTask();
      h.controller.users = [
        User.fromJson({
          'id': 'user-1',
          'displayName': 'Ada',
          'email': 'ada@example.com',
        }),
        User.fromJson({
          'id': 'user-2',
          'displayName': 'Mia',
          'email': 'mia@example.com',
        }),
      ];
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      final originalCount = h.controller.timeline.length;
      final editor = find.byKey(const Key('comment-composer'));
      await tester.enterText(editor, '@');
      await tester.pumpAndSettle();
      expect(find.text('@Ada'), findsOneWidget);
      expect(find.text('@Mia'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(h.controller.draft.text, '[@Mia](/users/user-2) ');
      expect(h.controller.timeline, hasLength(originalCount));
      await tester.tap(find.byKey(const Key('internal-toggle')));
      await tester.enterText(editor, 'Please @mi');
      await tester.pumpAndSettle();
      expect(find.text('@Mia'), findsOneWidget);
      await tester.tap(find.text('@Mia'));
      await tester.pumpAndSettle();
      expect(h.controller.draft.text, 'Please [@Mia](/users/user-2) ');
      expect(h.controller.draft.internal, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(h.controller.draft.text, isEmpty);
      expect(h.controller.timeline.last.body, 'Please [@Mia](/users/user-2) ');
      expect(h.controller.timeline.last.internal, isTrue);
      expect(tester.takeException(), isNull);
    },
  );
}
