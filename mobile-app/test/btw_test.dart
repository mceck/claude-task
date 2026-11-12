import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' hide ConnectionState;

import 'support.dart';

Json _btw(
  String id,
  String body, {
  String role = 'question',
  bool working = false,
  String position = '3',
  String thread = 'thread-1',
}) {
  final item = commentData(
    id,
    body,
    internal: true,
    position: position,
    kind: role == 'question' ? 'user' : 'system',
    author: role == 'question'
        ? null
        : {'id': null, 'displayName': 'Ada Bot', 'type': 'system'},
  );
  return {
    ...item,
    'comment': {
      ...(item['comment'] as Json),
      'btw': {'threadId': thread, 'role': role, 'working': working},
    },
  };
}

Json _cleared(String id, {String position = '4'}) {
  final item = commentData(
    id,
    'Chat cleared',
    kind: 'system',
    position: position,
  );
  return {
    ...item,
    'comment': {...(item['comment'] as Json), 'clearMarker': true},
  };
}

Future<Harness> _open(
  WidgetTester tester,
  List<Json> items, {
  Json? session,
  bool settle = true,
}) async {
  tester.view.physicalSize = const Size(430, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final h = Harness();
  addTearDown(h.dispose);
  h.api.items = items;
  h.api.session = session;
  await h.login();
  await h.openTask();
  await tester.pumpWidget(TaskApp(controller: h.controller));
  // A working Btw's spinner never settles.
  settle
      ? await tester.pumpAndSettle()
      : await tester.pump(const Duration(seconds: 1));
  return h;
}

void main() {
  test('the Btw fields come from the Comment and survive the cache', () {
    final entry = TimelineEntry(
      _btw('b', 'why?', working: true)..['type'] = 'comment',
    );
    expect(entry.isBtw, isTrue);
    expect(entry.btwThreadId, 'thread-1');
    expect(entry.btwRole, 'question');
    expect(entry.btwWorking, isTrue);
    expect(TimelineEntry(_cleared('c')).isClearMarker, isTrue);
    expect(TimelineEntry(commentData('p', 'plain')).isBtw, isFalse);
    final draft = Draft.fromJson(
      const Draft(text: 'x').copyWith(replyTo: 't', replyQuote: 'q').toJson(),
    );
    expect((draft.btwThread, draft.btwQuote), ('t', 'q'));
    expect(draft.copyWith(clearReply: true).btwThread, isNull);
    expect(btwQuote('one two three four', words: 2), 'one two…');
  });

  testWidgets('a Btw question and answer are drawn as Btw, not as Internal Notes',
      (tester) async {
    await _open(tester, [
      commentData('c1', 'Hello'),
      _btw('q', 'What changed?', working: true),
      _btw('a', 'The login form.', role: 'answer', position: '4'),
      _btw('f', 'Btw failed: timeout', role: 'failure', position: '5'),
    ], settle: false);
    expect(find.text('Btw'), findsNWidgets(3));
    expect(find.text('Thinking…'), findsOneWidget);
    expect(find.text('Internal chat'), findsNothing);
    expect(find.byKey(const ValueKey('btw-reply:q')), findsOneWidget);
    expect(find.byKey(const ValueKey('btw-reply:a')), findsOneWidget);
    // A failure notice has nothing to continue.
    expect(find.byKey(const ValueKey('btw-reply:f')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a Clear marker is a centred divider and shows Clear pending', (
    tester,
  ) async {
    await _open(
      tester,
      [commentData('c1', 'Hello'), _cleared('clear')],
      session: {'state': 'pending', 'clearPending': true},
    );
    expect(find.byKey(const ValueKey('clear-marker:clear')), findsOneWidget);
    expect(find.textContaining('Ada cleared the chat'), findsOneWidget);
    expect(find.text('Chat cleared'), findsNothing);
    expect(find.text('Clear pending'), findsOneWidget);
  });

  testWidgets('/btw and /clear are offered as System hints', (tester) async {
    final h = await _open(tester, []);
    await tester.enterText(find.byKey(const Key('comment-composer')), '/');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('skill-command:btw')), findsOneWidget);
    expect(find.byKey(const ValueKey('skill-command:clear')), findsOneWidget);
    expect(find.text('System'), findsNWidgets(3));
    await tester.tap(find.byKey(const ValueKey('skill-command:btw')));
    await tester.pumpAndSettle();
    expect(h.controller.draft.text, '/btw ');
    expect(h.controller.draft.internal, isFalse);
    expect(h.api.sendCount, 0);
  });

  testWidgets('Reply adds a dismissible chip and sends the thread', (
    tester,
  ) async {
    final h = await _open(tester, [_btw('a', 'The login form.', role: 'answer')]);
    await tester.tap(find.byKey(const ValueKey('btw-reply:a')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('btw-reply-chip')), findsOneWidget);
    expect(find.textContaining('Replying to btw: The login form.'), findsOneWidget);

    await tester.tap(find.byTooltip('Stop replying to btw'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('btw-reply-chip')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('btw-reply:a')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('comment-composer')), 'and?');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('send-comment')));
    await tester.pumpAndSettle();
    expect(h.api.lastCommentBody, {
      'body': 'and?',
      'internal': false,
      'btwThread': 'thread-1',
    });
    expect(h.controller.draft.btwThread, isNull);
  });

  testWidgets('/clear says what happened, and a 409 keeps the draft', (
    tester,
  ) async {
    final h = await _open(tester, []);
    h.api.commentTool = (body) => {
      'comment': _cleared('clear')['comment'],
      'clearPending': false,
    };
    await tester.enterText(find.byKey(const Key('comment-composer')), '/clear');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('send-comment')));
    await tester.pumpAndSettle();
    expect(h.api.lastCommentBody!['body'], '/clear');
    expect(find.text('Chat cleared'), findsWidgets);
    expect(find.byKey(const ValueKey('clear-marker:clear')), findsOneWidget);

    h.api.commentTool = (body) => {'comment': null, 'clearPending': true};
    await h.controller.setDraft(const Draft(text: '/clear'));
    expect(
      await h.controller.send(),
      'Clear pending: the chat will clear when the Agent finishes',
    );

    h.api.commentTool = (body) =>
        throw const ApiException(409, 'conflict', 'Another btw is working');
    await h.controller.setDraft(const Draft(text: '/btw why?'));
    await h.controller.send();
    expect(h.controller.error, 'Another btw is working');
    expect(h.controller.draft.text, '/btw why?');
    expect(h.controller.draft.ambiguous, isFalse);
  });

  test('/btw and /clear are refused offline and never queued', () async {
    final h = Harness();
    addTearDown(h.dispose);
    await h.login();
    await h.openTask();
    for (final text in ['/btw why?', '/clear']) {
      await h.controller.setDraft(Draft(text: text));
      h.api.offline = true;
      h.controller.connection = ConnectionState.offline;
      expect(await h.controller.send(), isNull);
      expect(h.api.sendCount, 0);
      expect(h.controller.draft.text, text);
      expect(h.controller.error, contains('retry once back online'));
    }
  });
}
