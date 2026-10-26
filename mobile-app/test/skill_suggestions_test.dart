import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/skill_suggestions.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support.dart';

void main() {
  testWidgets(
    'completes the token at the caret and keeps the surrounding draft',
    (tester) async {
      final text = TextEditingController();
      addTearDown(text.dispose);
      String? selected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SkillSuggestions(
              text: text,
              skills: [
                SkillCommand.fromJson({
                  'name': 'review',
                  'description': 'Review changes',
                }),
              ],
              onSelected: (v) => selected = v,
            ),
          ),
        ),
      );
      text.value = const TextEditingValue(
        text: 'Please /rev later',
        selection: TextSelection.collapsed(offset: 11),
      );
      await tester.pump();
      expect(find.text('/review'), findsOneWidget);
      await tester.tap(find.text('/review'));
      await tester.pump();
      expect(selected, 'Please /review  later');
      expect(text.selection.baseOffset, 15);
      text.value = const TextEditingValue(
        text: 'src/re',
        selection: TextSelection.collapsed(offset: 6),
      );
      await tester.pump();
      expect(find.text('/review'), findsNothing);
    },
  );

  testWidgets(
    'offers only the assigned agent skills and hides them in Internal Notes',
    (tester) async {
      tester.view.physicalSize = const Size(1600, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.openTask();
      h.controller.task = Task.fromJson({...taskData(), 'agentId': 'agent-1'});
      h.controller.agents = [
        Agent.fromJson({
          'id': 'agent-1',
          'name': 'Reviewer',
          'enabled': true,
          'skillCommands': [
            {'name': 'review', 'description': 'Review changes'},
          ],
        }),
        Agent.fromJson({
          'id': 'agent-2',
          'name': 'Writer',
          'enabled': true,
          'skillCommands': [
            {'name': 'write', 'description': 'Write docs'},
          ],
        }),
      ];
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('comment-composer')), '/');
      await tester.pumpAndSettle();
      expect(find.text('/review'), findsOneWidget);
      expect(find.text('/write'), findsNothing);
      await tester.tap(find.text('/review'));
      await tester.pumpAndSettle();
      expect(h.controller.draft.text, '/review ');
      h.controller.session = {
        ...?h.controller.session,
        'commands': [
          {
            'name': 'compact',
            'description': 'Summarize conversation history',
            'kind': 'claude',
          },
          {'name': 'review', 'description': 'Review changes', 'kind': 'skill'},
        ],
      };
      h.controller.notifyListeners();
      await tester.enterText(
        find.byKey(const Key('comment-composer')),
        '/comp',
      );
      await tester.pumpAndSettle();
      expect(find.text('/compact'), findsOneWidget);
      expect(find.text('/clear'), findsNothing);
      await tester.tap(find.text('/compact'));
      await tester.pumpAndSettle();
      expect(h.controller.draft.text, '/compact ');
      await tester.enterText(find.byKey(const Key('comment-composer')), '/re');
      await tester.tap(find.byKey(const ValueKey('segment:true')));
      await tester.pumpAndSettle();
      expect(find.text('/review'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
