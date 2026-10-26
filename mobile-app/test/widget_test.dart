import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:claude_task_mobile/src/app.dart';
import 'support.dart';

void main() {
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
    'phone navigates Project → grouped Tasks → conversation with a persistent Internal Note composer',
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
        find.textContaining('INTERNAL NOTE · never delivered'),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const Key('comment-composer')),
        'A draft for humans',
      );
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(h.controller.draft.internal, true);
      await tester.tap(find.byIcon(Icons.arrow_back));
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
      await tester.tap(find.text('🤖 Ada Bot').last);
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
}
