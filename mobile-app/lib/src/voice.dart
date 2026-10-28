import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:uuid/uuid.dart';

import 'models.dart';
import 'voice_audio.dart';

abstract class VoiceBackground {
  Future<void> start(String taskKey);
  Future<void> stop();
}

class NativeVoiceBackground implements VoiceBackground {
  static const _channel = MethodChannel('claude_task/voice');
  final VoidCallback onLeave;
  bool _running = false;
  NativeVoiceBackground(this.onLeave);
  @override
  Future<void> start(String taskKey) async {
    if (!Platform.isAndroid) return;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'leave') onLeave();
    });
    _running = true;
    await _channel.invokeMethod<void>('start', {'taskKey': taskKey});
  }

  @override
  Future<void> stop() async {
    if (!_running) return;
    _running = false;
    _channel.setMethodCallHandler(null);
    await _channel.invokeMethod<void>('stop');
  }
}

class VoiceTransfer extends Error {
  final String participantId, taskKey;
  VoiceTransfer(this.participantId, this.taskKey);
}

class VoiceController extends ChangeNotifier {
  final bool Function(Json) send;
  final VoiceAudio Function() audioFactory;
  late final VoiceBackground background;
  Json? room;
  final Map<String, Json> rooms = {};
  final Map<String, String> links = {};
  String? participantId, error;
  bool joining = false, muted = false, deafened = false;
  VoiceAudio? _audio, _pendingAudio;
  Completer<void>? _pending;
  String? _requestId;
  int _epoch = 0;
  Timer? _iceTimer;
  bool _disposed = false;

  VoiceController({
    required this.send,
    VoiceAudio Function()? audioFactory,
    VoiceBackground? background,
  }) : audioFactory = audioFactory ?? WebRtcVoiceAudio.new {
    this.background = background ?? NativeVoiceBackground(() => leave());
  }
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> join(String taskId, String taskKey, {String? replace}) async {
    if (joining || room?['taskId'] == taskId) return;
    final epoch = ++_epoch;
    joining = true;
    error = null;
    _notify();
    final audio = audioFactory();
    _pendingAudio = audio;
    try {
      await audio.start();
      if (epoch != _epoch) {
        await audio.stop();
        return;
      }
      await background.start(taskKey);
      if (epoch != _epoch) {
        await audio.stop();
        return;
      }
      _requestId = const Uuid().v4();
      _pending = Completer<void>();
      final result = _pending!.future.timeout(const Duration(seconds: 15));
      if (!send({
        'type': 'voice.join',
        'requestId': _requestId,
        'taskId': taskId,
        'replace': ?replace,
      })) {
        _pending!.completeError(
          StateError('Connect to the server before joining voice.'),
        );
      }
      await result;
    } catch (e) {
      // Invalidate admission before asynchronous media teardown: a late ack leaves immediately.
      if (epoch == _epoch) {
        _pending = null;
        _requestId = null;
      }
      if (_pendingAudio == audio) _pendingAudio = null;
      await audio.stop();
      if (epoch == _epoch && e is! VoiceTransfer) {
        error = e is StateError ? e.message.toString() : 'Could not join voice. Check microphone permission and your connection.';
      }
      if (epoch == _epoch && _audio == null) await background.stop();
      rethrow;
    } finally {
      if (epoch == _epoch) {
        _pending = null;
        _requestId = null;
        joining = false;
        _notify();
      }
    }
  }

  void handle(Json message) {
    switch (message['type']) {
      case 'voice.joined':
        if (_pending == null || _requestId != message['requestId']) {
          send({
            'type': 'voice.leave',
            'participantId': message['participantId'],
          });
          return;
        }
        final old = _audio;
        _audio = _pendingAudio;
        _pendingAudio = null;
        if (old != null) unawaited(old.stop());
        participantId = message['participantId'] as String;
        muted = false;
        deafened = false;
        links.clear();
        error = null;
        _configureIce(message);
        room = Map<String, dynamic>.from(message['room'] as Map);
        _room(room!);
        _pending!.complete();
      case 'voice.ice':
        if (message['participantId'] == participantId) {
          _configureIce(message);
          for (final id in links.keys.toList()) {
            _audio?.retry(id);
          }
        }
      case 'voice.error':
        if (_requestId == message['requestId'] &&
            _pending != null &&
            !_pending!.isCompleted) {
          final current = message['current'] as Map?;
          _pending!.completeError(
            current != null
                ? VoiceTransfer(
                    current['participantId'] as String,
                    current['taskKey'] as String,
                  )
                : StateError(message['message'] as String),
          );
        }
      case 'voice.room':
        _room(Map<String, dynamic>.from(message['room'] as Map));
      case 'voice.signal':
        if (message['toId'] == participantId) {
          _audio?.receive(
            message['fromId'] as String,
            Map<String, dynamic>.from(message['signal'] as Map),
          );
        }
      case 'voice.left':
        if (message['participantId'] == participantId) {
          final reason = message['reason'];
          _clear(keepPending: joining);
          if (reason != 'left') {
            error = reason == 'transferred'
                ? 'Voice moved to another Task or device.'
                : 'This Voice Room has ended.';
          }
          _notify();
        }
    }
  }

  void _configureIce(Json message) {
    _audio!.configure(
      participantId!,
      message['iceServers'] as List,
      (target, signal) {
        if (participantId != null) {
          send({
            'type': 'voice.signal',
            'participantId': participantId,
            'targetId': target,
            'signal': signal,
          });
        }
      },
      (id, status) {
        links[id] = status;
        _notify();
      },
    );
    _iceTimer?.cancel();
    final expires = DateTime.tryParse(message['iceExpiresAt'] as String? ?? '');
    if (expires == null) return;
    final id = participantId;
    void refresh() {
      if (id == null || id != participantId || _disposed) return;
      _iceTimer = Timer(const Duration(seconds: 30), refresh);
      send({'type': 'voice.ice', 'participantId': id});
    }

    final delay = (expires.difference(DateTime.now()).inMilliseconds ~/ 2)
        .clamp(1000, 86400000);
    _iceTimer = Timer(Duration(milliseconds: delay), refresh);
  }

  void _room(Json value) {
    rooms[value['taskId'] as String] = value;
    if (room?['taskId'] == value['taskId'] && participantId != null) {
      room = value;
      final ids = {
        for (final p in value['participants'] as List)
          if ((p as Map)['id'] != participantId) p['id'] as String,
      };
      links.removeWhere((id, _) => !ids.contains(id));
      _audio?.peers(ids);
    }
    _notify();
  }

  void observe(Json value) => _room(value);
  void mute() {
    if (participantId == null) return;
    muted = !muted;
    _audio?.mute(muted);
    send({
      'type': 'voice.mute',
      'participantId': participantId,
      'muted': muted,
    });
    _notify();
  }

  void deafen() {
    deafened = !deafened;
    _audio?.deafen(deafened);
    _notify();
  }

  void retry(String id) => _audio?.retry(id);
  void leave() {
    error = null;
    if (participantId != null) {
      send({'type': 'voice.leave', 'participantId': participantId});
    }
    disconnected(null);
  }

  void disconnected([
    String? message = 'Voice connection lost. Join again when connected.',
  ]) {
    final active = participantId != null || joining;
    _epoch++;
    if (_pending != null && !_pending!.isCompleted) {
      _pending!.completeError(StateError(message ?? 'Voice join cancelled.'));
    }
    _pending = null;
    _requestId = null;
    _clear();
    joining = false;
    if (active) error = message;
    rooms.clear();
    _notify();
  }

  void dismissError() {
    error = null;
    _notify();
  }

  void _clear({bool keepPending = false}) {
    _iceTimer?.cancel();
    final audio = _audio;
    _audio = null;
    if (audio != null) unawaited(audio.stop());
    if (!keepPending) {
      final pending = _pendingAudio;
      _pendingAudio = null;
      if (pending != null) unawaited(pending.stop());
      unawaited(background.stop());
    }
    participantId = null;
    room = null;
    links.clear();
    muted = false;
    deafened = false;
  }

  @override
  void dispose() {
    _disposed = true;
    disconnected(null);
    super.dispose();
  }
}
