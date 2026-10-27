import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:claude_task_mobile/src/app.dart';

import 'support.dart';

void main() {
  for (final internal in [false, true]) {
    testWidgets(
      'Enter sends and Shift+Enter inserts a newline in ${internal ? 'Internal chat' : 'Comments'}',
      (tester) async {
        final h = Harness();
        addTearDown(h.dispose);
        await h.login();
        await h.openTask();
        await tester.pumpWidget(TaskApp(controller: h.controller));
        await tester.pumpAndSettle();
        if (internal) {
          await tester.tap(find.byKey(const Key('internal-toggle')));
          await tester.pumpAndSettle();
        }
        final field = find.byKey(const Key('comment-composer'));
        await tester.enterText(field, 'FirstSecond');
        final text = tester.widget<TextField>(field).controller!;
        text.selection = const TextSelection.collapsed(offset: 5);
        await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        await tester.pumpAndSettle();
        expect(text.text, 'First\nSecond');
        expect(text.selection, const TextSelection.collapsed(offset: 6));
        expect(h.controller.draft.text, 'First\nSecond');
        expect(h.api.sendCount, 0);

        // A selected range is replaced, rather than appending at the end.
        text.selection = const TextSelection(baseOffset: 6, extentOffset: 12);
        await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.numpadEnter);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        await tester.pumpAndSettle();
        expect(h.controller.draft.text, 'First\n\n');
        expect(h.api.sendCount, 0);

        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(h.api.sendCount, 1);
        final sent = h.api.items.last['comment'] as Map;
        expect(sent['body'], 'First\n\n');
        expect(sent['internal'], internal);
        expect(h.controller.draft.text, isEmpty);
        expect(text.text, isEmpty);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('composer supports phone Send and Ctrl/Cmd+Enter', (
    tester,
  ) async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    final field = find.byKey(const Key('comment-composer'));
    await tester.enterText(field, 'Phone message');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(h.api.sendCount, 1);
    for (final modifier in [
      LogicalKeyboardKey.controlLeft,
      LogicalKeyboardKey.metaLeft,
    ]) {
      await tester.enterText(field, 'Keyboard message');
      await tester.sendKeyDownEvent(modifier);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(modifier);
      await tester.pumpAndSettle();
    }
    expect(h.api.sendCount, 3);
    await tester.enterText(field, 'Keypad message');
    await tester.sendKeyEvent(LogicalKeyboardKey.numpadEnter);
    await tester.pumpAndSettle();
    expect(h.api.sendCount, 4);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Enter preserves composition and does not retry an unknown send',
    (tester) async {
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.openTask();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      final field = find.byKey(const Key('comment-composer'));
      await tester.enterText(field, 'Draft');
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'Draft',
          selection: TextSelection.collapsed(offset: 5),
          composing: TextRange(start: 0, end: 5),
        ),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(h.api.sendCount, 0);
      expect(h.controller.draft.text, 'Draft');

      await tester.enterText(field, 'Keep this draft');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyRepeatEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(h.api.sendCount, 1);

      h.api.failSend = true;
      await tester.enterText(field, 'Unknown outcome');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(h.api.sendCount, 2);
      expect(h.controller.draft.ambiguous, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(h.api.sendCount, 2);
      expect(h.controller.draft.text, 'Unknown outcome');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'login collects installation URL and authenticates into Projects',
    (tester) async {
      final h = Harness();
      addTearDown(h.dispose);
      await h.controller.initialize();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.enterText(
        find.byKey(const Key('installation-url')),
        'https://tasks.example.com',
      );
      await tester.enterText(find.byKey(const Key('email')), 'ada@example.com');
      await tester.enterText(find.byKey(const Key('password')), 'password');
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();
      expect(find.text('Projects'), findsOneWidget);
      expect(find.text('Payments'), findsOneWidget);
    },
  );
  testWidgets(
    'phone navigates Project → grouped Tasks → conversation with a persistent Internal chat composer',
    (tester) async {
      tester.view.physicalSize = const Size(430, 932);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.tap(find.text('Payments'));
      await tester.pumpAndSettle();
      expect(find.text('OPEN'), findsOneWidget);
      expect(find.text('Fix login'), findsOneWidget);
      expect(find.text('Archived Task'), findsNothing);
      await tester.tap(find.text('Archive'));
      await tester.pumpAndSettle();
      expect(find.text('Archived Task'), findsOneWidget);
      await tester.tap(find.text('Fix login'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('comment-composer')), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const Key('internal-toggle')),
          matching: find.byTooltip('Comment · switch to Internal chat'),
        ),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const Key('comment-composer')),
        'A draft for humans',
      );
      await tester.tap(find.byKey(const Key('internal-toggle')));
      await tester.pumpAndSettle();
      expect(h.controller.draft.internal, true);
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Fix login'));
      await tester.pumpAndSettle();
      expect(find.text('A draft for humans'), findsOneWidget);
      expect(h.controller.draft.internal, true);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'wide layout shows Project rail, Status groups and conversation together',
    (tester) async {
      tester.view.physicalSize = const Size(1600, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.openTask();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      expect(find.text('API'), findsOneWidget);
      expect(find.text('OPEN'), findsOneWidget);
      expect(find.byKey(const Key('comment-composer')), findsOneWidget);
      expect(find.text('Task details'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'optional Agent changes Create Task to Create and assign and preserves partial success',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.controller.selectProject(h.controller.projects.first);
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.tap(find.byTooltip('Create Task'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('new-task-title')),
        'Optional Agent Task',
      );
      await tester.tap(find.byKey(const Key('new-task-agent')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Ada Bot').last);
      await tester.pumpAndSettle();
      expect(find.text('Create and assign'), findsOneWidget);
      h.api.failAssignment = true;
      await tester.tap(find.text('Create and assign'));
      await tester.pumpAndSettle();
      expect(h.api.createCount, 1);
      expect(find.text('Retry assignment'), findsOneWidget);
      expect(h.controller.task!.title, 'Optional Agent Task');
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'conversation describes Revisions in words and offers to notify the Agent of unseen changes',
    (tester) async {
      tester.view.physicalSize = const Size(430, 932);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      h.api.currentTask = {...taskData(), 'agentId': 'agent-1'};
      h.api.items = [
        commentData('comment-1', 'Hello team'),
        revisionData('revision-1', [
          {'field': 'statusId', 'before': 'status-1', 'after': 'status-2'},
        ], position: '2'),
        revisionData('revision-2', [
          {'field': 'description', 'before': 'a', 'after': 'b'},
        ], position: '3'),
        revisionData('revision-3', [
          {'field': 'description', 'before': 'b', 'after': 'c'},
        ], position: '4'),
      ];
      h.api.session = {
        'state': 'idle',
        'queuePosition': null,
        'held': false,
        'unseenChanges': true,
      };
      await h.login();
      await h.openTask();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      // Changes are hidden by default.
      expect(find.textContaining('moved it from Open to Closed'), findsNothing);
      await tester.tap(find.byKey(const Key('hide-changes')));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('moved it from Open to Closed'),
        findsOneWidget,
      );
      // Identical consecutive changes fold into one line.
      expect(find.textContaining('updated the description'), findsOneWidget);
      expect(find.textContaining('×2'), findsOneWidget);
      expect(find.text('waiting for messages'), findsOneWidget);
      await tester.tap(find.byKey(const Key('session-notify')));
      await tester.pumpAndSettle();
      expect(h.api.calls, contains('POST /tasks/task-1/session/notify'));
      expect(find.byKey(const Key('session-notify')), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'switching to Internal chat keeps the composer in place and the text focused',
    (tester) async {
      tester.view.physicalSize = const Size(430, 932);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.openTask();
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      final field = find.byKey(const Key('comment-composer'));
      await tester.tap(field);
      await tester.enterText(field, 'Keep this draft');
      await tester.pumpAndSettle();
      final before = tester.getRect(field);
      final toggle = find.byKey(const Key('internal-toggle'));
      expect(tester.getSize(toggle), const Size(36, 36));
      final editable = tester.state<EditableTextState>(
        find.descendant(of: field, matching: find.byType(EditableText)),
      );
      await tester.tap(find.byKey(const Key('internal-toggle')));
      await tester.pump();
      expect(tester.getRect(field), before);
      await tester.pumpAndSettle();
      expect(tester.getRect(field), before);
      expect(
        tester.state<EditableTextState>(
          find.descendant(of: field, matching: find.byType(EditableText)),
        ),
        same(editable),
      );
      expect(h.controller.draft.text, 'Keep this draft');
      expect(h.controller.draft.internal, isTrue);
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(tester.widget<Semantics>(toggle).properties.toggled, isTrue);
      expect(
        find.byTooltip('Internal chat · switch to Comment'),
        findsOneWidget,
      );
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(h.controller.draft.internal, isFalse);
      expect(h.controller.draft.text, 'Keep this draft');
      expect(tester.getRect(field), before);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('long Comments are clamped from their first frame', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(430, 932);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final h = Harness();
    addTearDown(h.dispose);
    h.api.items = [
      commentData('long', List.filled(60, 'A long line of text.').join('\n\n')),
    ];
    await h.login();
    await h.openTask();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pump();
    expect(find.text('Show more'), findsOneWidget);
    await tester.tap(find.text('Show more'));
    await tester.pump();
    expect(find.text('Show less'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
