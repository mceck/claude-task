import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/voice.dart';
import 'package:claude_task_mobile/src/voice_audio.dart';
import 'package:claude_task_mobile/src/voice_widgets.dart';
import 'package:claude_task_mobile/src/ui/theme.dart';

class FakeAudio implements VoiceAudio {
  bool started = false, stopped = false, muted = false, deafened = false;
  Set<String> connectedPeers = {};
  final List<String> retried = [];
  final List<Json> signals = [];
  Completer<void>? permission, stopWait;
  @override
  Future<void> start() async {
    started = true;
    await permission?.future;
  }

  @override
  void configure(
    String participantId,
    List<dynamic> iceServers,
    void Function(String, Json) send,
    void Function(String, String) link,
  ) {}
  @override
  void peers(Set<String> ids) {
    connectedPeers = ids;
  }

  @override
  void receive(String fromId, Json signal) {
    signals.add(signal);
  }

  @override
  void retry(String id) {
    retried.add(id);
  }

  @override
  void mute(bool value) {
    muted = value;
  }

  @override
  void deafen(bool value) {
    deafened = value;
  }

  @override
  Future<void> stop() async {
    stopped = true;
    await stopWait?.future;
  }
}

class FakeBackground implements VoiceBackground {
  bool running = false;
  @override
  Future<void> start(String taskKey) async {
    running = true;
  }

  @override
  Future<void> stop() async {
    running = false;
  }
}

Json room({String task = 'task-a', List<Json>? participants}) => {
  'taskId': task,
  'taskKey': 'API-1',
  'participants':
      participants ??
      [
        {
          'id': 'participant-a',
          'user': {'id': 'user-a', 'displayName': 'Ada'},
          'muted': false,
        },
        {
          'id': 'participant-b',
          'user': {'id': 'user-b', 'displayName': 'Bea'},
          'muted': false,
        },
      ],
};
void admit(VoiceController voice, List<Json> sent) {
  voice.handle({
    'type': 'voice.joined',
    'requestId': sent.last['requestId'],
    'participantId': 'participant-a',
    'iceServers': [
      {
        'urls': ['stun:example.com'],
      },
    ],
    'room': room(),
  });
}

void main() {
  test('native joins the shared contract, scopes signals and releases audio on transfer', () async {
    final audio = FakeAudio(), background = FakeBackground(), sent = <Json>[];
    final voice = VoiceController(
      send: (m) {
        sent.add(m);
        return true;
      },
      audioFactory: () => audio,
      background: background,
    );
    addTearDown(voice.dispose);
    final joining = voice.join('task-a', 'API-1');
    await Future<void>.delayed(Duration.zero);
    expect(audio.started, true);
    expect(background.running, true);
    expect(sent.single, containsPair('type', 'voice.join'));
    admit(voice, sent);
    await joining;
    expect(audio.connectedPeers, {'participant-b'});
    voice.handle({
      'type': 'voice.signal',
      'toId': 'old-participation',
      'fromId': 'participant-b',
      'signal': {'type': 'retry'},
    });
    expect(audio.signals, isEmpty);
    voice.handle({
      'type': 'voice.signal',
      'toId': 'participant-a',
      'fromId': 'participant-b',
      'signal': {'type': 'retry'},
    });
    expect(audio.signals, hasLength(1));
    voice.mute();
    voice.deafen();
    expect(audio.muted, true);
    expect(audio.deafened, true);
    expect(sent.last, {
      'type': 'voice.mute',
      'participantId': 'participant-a',
      'muted': true,
    });
    voice.handle({
      'type': 'voice.left',
      'participantId': 'participant-a',
      'reason': 'transferred',
    });
    await Future<void>.delayed(Duration.zero);
    expect(audio.stopped, true);
    expect(background.running, false);
    expect(voice.participantId, isNull);
    expect(voice.error, contains('moved'));
  });

  test('a full room preserves the current participation and stops only the new capture', () async {
    final audios = <FakeAudio>[], sent = <Json>[];
    final voice = VoiceController(
      send: (m) {
        sent.add(m);
        return true;
      },
      audioFactory: () {
        final a = FakeAudio();
        audios.add(a);
        return a;
      },
      background: FakeBackground(),
    );
    addTearDown(voice.dispose);
    var joining = voice.join('task-a', 'API-1');
    await Future<void>.delayed(Duration.zero);
    admit(voice, sent);
    await joining;
    joining = voice.join('task-b', 'API-2', replace: 'participant-a');
    final failure = expectLater(joining, throwsStateError);
    await Future<void>.delayed(Duration.zero);
    voice.handle({
      'type': 'voice.error',
      'requestId': sent.last['requestId'],
      'code': 'full',
      'message': 'This Voice Room is full (6 people).',
    });
    await failure;
    expect(voice.room!['taskId'], 'task-a');
    expect(audios[0].stopped, false);
    expect(audios[1].stopped, true);
  });

  test(
    'disconnect while microphone permission is pending cannot join later',
    () async {
      final audio = FakeAudio()..permission = Completer<void>();
      final sent = <Json>[], background = FakeBackground();
      final voice = VoiceController(
        send: (m) {
          sent.add(m);
          return true;
        },
        audioFactory: () => audio,
        background: background,
      );
      addTearDown(voice.dispose);
      final joining = voice.join('task-a', 'API-1');
      voice.disconnected();
      audio.permission!.complete();
      await joining;
      expect(sent, isEmpty);
      expect(audio.stopped, true);
      expect(background.running, false);
    },
  );

  test(
    'obsolete join cleanup preserves the new join background service',
    () async {
      final first = FakeAudio()..stopWait = Completer<void>();
      final second = FakeAudio();
      final background = FakeBackground(), sent = <Json>[];
      var created = 0;
      final voice = VoiceController(
        send: (m) {
          sent.add(m);
          return true;
        },
        audioFactory: () => created++ == 0 ? first : second,
        background: background,
      );
      addTearDown(voice.dispose);
      final joiningA = voice.join('task-a', 'API-1');
      final failedA = expectLater(joiningA, throwsStateError);
      await Future<void>.delayed(Duration.zero);
      voice.disconnected();
      final joiningB = voice.join('task-b', 'API-2');
      await Future<void>.delayed(Duration.zero);
      expect(background.running, true);
      first.stopWait!.complete();
      await failedA;
      expect(background.running, true);
      admit(voice, sent);
      await joiningB;
      expect(background.running, true);
      expect(second.stopped, false);
    },
  );

  testWidgets(
    'late admission after timeout leaves while microphone teardown is pending',
    (tester) async {
      final audio = FakeAudio()..stopWait = Completer<void>();
      final sent = <Json>[];
      final voice = VoiceController(
        send: (m) {
          sent.add(m);
          return true;
        },
        audioFactory: () => audio,
        background: FakeBackground(),
      );
      addTearDown(voice.dispose);
      final joining = voice.join('task-a', 'API-1');
      final failure = expectLater(joining, throwsA(isA<TimeoutException>()));
      await tester.pump();
      final requestId = sent.single['requestId'];
      await tester.pump(const Duration(seconds: 16));
      voice.handle({
        'type': 'voice.joined',
        'requestId': requestId,
        'participantId': 'late-participant',
        'iceServers': [],
        'room': room(),
      });
      expect(sent.last, {
        'type': 'voice.leave',
        'participantId': 'late-participant',
      });
      expect(voice.participantId, isNull);
      audio.stopWait!.complete();
      await tester.pump();
      await failure;
    },
  );

  testWidgets('persistent controls show failed peers, retry, mute and leave', (
    tester,
  ) async {
    final audio = FakeAudio(), sent = <Json>[];
    final voice = VoiceController(
      send: (m) {
        sent.add(m);
        return true;
      },
      audioFactory: () => audio,
      background: FakeBackground(),
    );
    addTearDown(voice.dispose);
    final joining = voice.join('task-a', 'API-1');
    await tester.pump();
    admit(voice, sent);
    await joining;
    voice.links['participant-b'] = 'unavailable';
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(),
        home: Scaffold(body: VoiceControls(voice: voice)),
      ),
    );
    expect(find.text('Voice · API-1'), findsOneWidget);
    expect(
      find.text(
        'Some people cannot hear you. Retry or try another network to make a direct connection.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.byTooltip('Retry connection to Bea'));
    expect(audio.retried, ['participant-b']);
    await tester.tap(find.text('Mute'));
    await tester.pump();
    expect(audio.muted, true);
    expect(find.text('Unmute'), findsOneWidget);
    await tester.tap(find.text('Leave voice'));
    await tester.pump();
    expect(find.text('Voice · API-1'), findsNothing);
    expect(audio.stopped, true);
  });
}
