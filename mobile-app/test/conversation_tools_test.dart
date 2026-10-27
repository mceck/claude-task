import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' hide ConnectionState;
import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';

import 'support.dart';

const _answers = [
  QuestionAnswer(['Postgres']),
  QuestionAnswer(['iOS', 'Android'], 'Web too'),
];

Json _questionComment({List<Json>? answer, Json? answeredBy}) => commentData(
  'question-1',
  '**Database**: Which database should I use?',
  kind: 'agent',
  position: '3',
  question: questionData(answer: answer, answeredBy: answeredBy),
);

Json _surveyComment({
  List<Json> responses = const [],
  bool closed = false,
  Json? closedBy,
}) => commentData(
  'survey-1',
  '**Database**: Which database should I use?',
  kind: 'agent',
  position: '3',
  survey: surveyData(responses: responses, closed: closed, closedBy: closedBy),
);

List<Json> _json(List<QuestionAnswer> answers) => [
  for (final a in answers) a.toJson(),
];

Future<Harness> _open(List<Json> items) async {
  final h = Harness();
  h.api.items = [commentData('comment-1', 'Ask me'), ...items];
  await h.login();
  await h.openTask();
  return h;
}

TimelineEntry _entry(Harness h, String id) =>
    h.controller.timeline.firstWhere((e) => e.id == id);

void main() {
  group('TaskController', () {
    test(
      'answering a Question posts every item and merges the Question and the answer',
      () async {
        final h = await _open([_questionComment()]);
        addTearDown(h.dispose);
        expect(_entry(h, 'question-1').question!.open, isTrue);
        h.api.conversationTool = (method, path, body) => {
          'question': _questionComment(
            answer: _json(_answers),
            answeredBy: ada,
          )['comment'],
          'answer': commentData(
            'answer-1',
            'Answer to your question',
            position: '6',
            answersCommentId: 'question-1',
          )['comment'],
        };
        expect(await h.controller.answerQuestion('question-1', _answers), true);
        expect(h.api.calls, contains('POST /comments/question-1/answer'));
        expect(h.api.bodies['POST /comments/question-1/answer'], {
          'answers': [
            {
              'selected': ['Postgres'],
              'other': null,
            },
            {
              'selected': ['iOS', 'Android'],
              'other': 'Web too',
            },
          ],
        });
        final question = _entry(h, 'question-1').question!;
        expect(question.open, isFalse);
        expect(question.answeredBy!.displayName, 'Ada');
        expect(_entry(h, 'answer-1').answersCommentId, 'question-1');
        expect(h.controller.error, isNull);
      },
    );

    test(
      'a Question answered meanwhile refreshes the Timeline and says who answered',
      () async {
        final h = await _open([_questionComment()]);
        addTearDown(h.dispose);
        h.api.conversationTool = (method, path, body) {
          h.api.items = [
            _questionComment(
              answer: [
                {
                  'selected': ['SQLite'],
                  'other': null,
                },
                {
                  'selected': ['iOS'],
                  'other': null,
                },
              ],
              answeredBy: mia,
            ),
          ];
          throw const ApiException(
            409,
            'conflict',
            'This question was already answered by Mia',
          );
        };
        expect(
          await h.controller.answerQuestion('question-1', _answers),
          false,
        );
        expect(h.controller.error, 'This question was already answered by Mia');
        final question = _entry(h, 'question-1').question!;
        expect(question.open, isFalse);
        expect(question.answeredBy!.displayName, 'Mia');
        expect(question.answer!.first.selected, ['SQLite']);
      },
    );

    test(
      'answering offline keeps the card and asks to answer once online',
      () async {
        final h = await _open([_questionComment(), _surveyComment()]);
        addTearDown(h.dispose);
        h.controller.connection = ConnectionState.offline;
        final before = h.api.calls.length;
        expect(
          await h.controller.answerQuestion('question-1', _answers),
          false,
        );
        expect(await h.controller.respondToSurvey('survey-1', _answers), false);
        expect(await h.controller.closeSurvey('survey-1'), false);
        expect(h.api.calls.length, before);
        expect(h.controller.error, contains('once back online'));
        expect(_entry(h, 'question-1').question!.open, isTrue);
      },
    );

    test(
      'responding to and closing a Survey merge the returned Survey',
      () async {
        final h = await _open([_surveyComment()]);
        addTearDown(h.dispose);
        h.api.conversationTool = (method, path, body) => {
          'comment': path.endsWith('/response')
              ? _surveyComment(
                  responses: [responseData(ada, _json(_answers))],
                )['comment']
              : _surveyComment(
                  responses: [responseData(ada, _json(_answers))],
                  closed: true,
                  closedBy: mia,
                )['comment'],
        };
        expect(await h.controller.respondToSurvey('survey-1', _answers), true);
        expect(h.api.calls, contains('PUT /comments/survey-1/response'));
        expect(h.api.bodies['PUT /comments/survey-1/response'], {
          'answers': _json(_answers),
        });
        var survey = _entry(h, 'survey-1').survey!;
        expect(survey.open, isTrue);
        expect(survey.responseOf('user-1')!.answers.last.other, 'Web too');

        expect(await h.controller.closeSurvey('survey-1'), true);
        expect(h.api.calls, contains('POST /comments/survey-1/close'));
        expect(
          h.api.bodies,
          containsPair('POST /comments/survey-1/close', null),
        );
        survey = _entry(h, 'survey-1').survey!;
        expect(survey.open, isFalse);
        expect(survey.closedBy!.displayName, 'Mia');
      },
    );

    test('a Survey closed meanwhile refreshes the Timeline', () async {
      final h = await _open([_surveyComment()]);
      addTearDown(h.dispose);
      h.api.conversationTool = (method, path, body) {
        h.api.items = [_surveyComment(closed: true, closedBy: mia)];
        throw const ApiException(409, 'conflict', 'This survey is closed');
      };
      expect(await h.controller.respondToSurvey('survey-1', _answers), false);
      expect(h.controller.error, 'This survey is closed');
      expect(_entry(h, 'survey-1').survey!.open, isFalse);
    });
  });

  group('cards', () {
    Future<Harness> pump(WidgetTester tester, List<Json> items) async {
      tester.view.physicalSize = const Size(430, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = await _open(items);
      addTearDown(h.dispose);
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      return h;
    }

    AppButton button(WidgetTester tester, String label) =>
        tester.widget<AppButton>(find.widgetWithText(AppButton, label));

    testWidgets('an open Question is answered once every item is valid', (
      tester,
    ) async {
      final h = await pump(tester, [_questionComment()]);
      expect(find.text('Which **database** should I use?'), findsNothing);
      expect(find.text('Already in the stack'), findsOneWidget);
      expect(button(tester, 'Send answer').onPressed, isNull);

      await tester.tap(find.text('Postgres'));
      await tester.pump();
      expect(button(tester, 'Send answer').onPressed, isNull);
      // Multiple choice: options and "Other" together.
      await tester.tap(find.text('iOS'));
      await tester.tap(find.text('Android'));
      await tester.tap(find.text('Other').last);
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('question-other:question-1:1')),
        '  Web too ',
      );
      await tester.pump();
      // Single choice: "Other" replaces the option, and needs text.
      await tester.tap(find.text('Other').first);
      await tester.pump();
      expect(button(tester, 'Send answer').onPressed, isNull);
      await tester.tap(find.text('Postgres'));
      await tester.pump();
      expect(
        find.byKey(const ValueKey('question-other:question-1:0')),
        findsNothing,
      );

      h.api.conversationTool = (method, path, body) => {
        'question': _questionComment(
          answer: objects(body!['answers']),
          answeredBy: ada,
        )['comment'],
        'answer': commentData(
          'answer-1',
          'Answer to your question',
          position: '6',
          answersCommentId: 'question-1',
        )['comment'],
      };
      await tester.tap(find.text('Send answer'));
      await tester.pumpAndSettle();
      expect(h.api.bodies['POST /comments/question-1/answer'], {
        'answers': [
          {
            'selected': ['Postgres'],
            'other': null,
          },
          {
            'selected': ['iOS', 'Android'],
            'other': 'Web too',
          },
        ],
      });
      expect(find.text('Send answer'), findsNothing);
      expect(find.textContaining('Answered by Ada'), findsOneWidget);
      expect(find.text('Web too'), findsOneWidget);
      expect(find.textContaining('answered the question'), findsOneWidget);
      expect(find.text('Answer to your question'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an answered Question shows the answer read-only', (
      tester,
    ) async {
      final h = await pump(tester, [
        _questionComment(
          answer: [
            {
              'selected': ['SQLite'],
              'other': null,
            },
            {'selected': <String>[], 'other': 'Desktop'},
          ],
          answeredBy: mia,
        ),
      ]);
      expect(find.textContaining('Answered by Mia'), findsOneWidget);
      expect(find.text('Desktop'), findsOneWidget);
      expect(find.text('Send answer'), findsNothing);
      await tester.tap(find.text('Postgres'));
      await tester.pump();
      expect(h.api.calls.where((c) => c.startsWith('POST /comments')), isEmpty);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'an open Survey prefills the own answer, shows who answered and sends now',
      (tester) async {
        final h = await pump(tester, [
          _surveyComment(
            responses: [
              responseData(ada, [
                {
                  'selected': ['Postgres'],
                  'other': null,
                },
                {
                  'selected': ['iOS'],
                  'other': null,
                },
              ]),
              responseData(
                {'id': 'user-3', 'displayName': 'Leo', 'type': 'user'},
                [
                  {
                    'selected': ['Postgres'],
                    'other': null,
                  },
                  {'selected': <String>[], 'other': 'Desktop'},
                ],
              ),
            ],
          ),
        ]);
        expect(find.text('Update answer'), findsOneWidget);
        expect(button(tester, 'Update answer').onPressed, isNotNull);
        expect(find.text('Ada, Leo'), findsOneWidget);
        expect(find.text('Leo: “Desktop”'), findsOneWidget);
        expect(
          find.textContaining('1/2 expected answered · waiting for Mia'),
          findsOneWidget,
        );

        h.api.conversationTool = (method, path, body) => {
          'comment': _surveyComment(
            responses: [
              responseData(ada, objects(body!['answers']), position: '7'),
            ],
          )['comment'],
        };
        await tester.tap(find.text('Android'));
        await tester.pump();
        await tester.tap(find.text('Update answer'));
        await tester.pumpAndSettle();
        expect(h.api.calls, contains('PUT /comments/survey-1/response'));
        expect(
          objects(
            h.api.bodies['PUT /comments/survey-1/response']!['answers'],
          ).last['selected'],
          ['iOS', 'Android'],
        );
        expect(find.text('Answer saved'), findsOneWidget);

        h.api.conversationTool = (method, path, body) => {
          'comment': _surveyComment(closed: true, closedBy: ada)['comment'],
        };
        await tester.tap(find.text('Send now'));
        await tester.pumpAndSettle();
        expect(h.api.calls, contains('POST /comments/survey-1/close'));
        expect(find.textContaining('Closed by Ada'), findsOneWidget);
        expect(find.text('Send now'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('a new Survey offers Save answer once every item is valid', (
      tester,
    ) async {
      await pump(tester, [_surveyComment()]);
      expect(
        find.text('0/2 expected answered · waiting for Ada, Mia'),
        findsOneWidget,
      );
      expect(button(tester, 'Save answer').onPressed, isNull);
      await tester.tap(find.text('SQLite'));
      await tester.tap(find.text('Android'));
      await tester.pump();
      expect(button(tester, 'Save answer').onPressed, isNotNull);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a closed Survey shows the final results', (tester) async {
      await pump(tester, [
        _surveyComment(
          closed: true,
          responses: [
            responseData(ada, [
              {
                'selected': ['Postgres'],
                'other': null,
              },
              {
                'selected': ['iOS'],
                'other': null,
              },
            ]),
            responseData(mia, [
              {
                'selected': ['SQLite'],
                'other': null,
              },
              {
                'selected': ['iOS'],
                'other': null,
              },
            ]),
          ],
        ),
      ]);
      expect(find.textContaining('Everyone answered'), findsOneWidget);
      expect(find.text('2/2 expected answered'), findsOneWidget);
      expect(find.text('Ada, Mia'), findsOneWidget);
      expect(find.text('Send now'), findsNothing);
      expect(find.text('Update answer'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });
}
