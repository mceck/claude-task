import 'dart:async';
import 'dart:io';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:uuid/uuid.dart';

import 'models.dart';

/// Media boundary used by the native Voice Room controller and its widget tests.
abstract class VoiceAudio {
  Future<void> start();
  void configure(
    String participantId,
    List<dynamic> iceServers,
    void Function(String, Json) send,
    void Function(String, String) link,
  );
  void peers(Set<String> ids);
  void receive(String fromId, Json signal);
  void retry(String id);
  void mute(bool muted);
  void deafen(bool deafened);
  Future<void> stop();
}

class _Peer {
  final String id;
  RTCPeerConnection? pc;
  String? exchangeId;
  Timer? timer;
  Future<void> queue = Future.value();
  List<Json> candidates = [];
  List<MediaStreamTrack> remoteTracks = [];
  _Peer(this.id);
}

class WebRtcVoiceAudio implements VoiceAudio {
  MediaStream? _stream;
  final Map<String, _Peer> _peers = {};
  String? _id;
  bool _stopped = false, _deafened = false;
  List<dynamic> _iceServers = [];
  void Function(String, Json)? _send;
  void Function(String, String)? _link;

  @override
  Future<void> start() async {
    if (Platform.isIOS) {
      await Helper.setAppleAudioConfiguration(
        AppleAudioConfiguration(
          appleAudioCategory: AppleAudioCategory.playAndRecord,
          appleAudioMode: AppleAudioMode.voiceChat,
          appleAudioCategoryOptions: {
            AppleAudioCategoryOption.allowBluetooth,
            AppleAudioCategoryOption.defaultToSpeaker,
          },
        ),
      );
    }
    final stream = await navigator.mediaDevices.getUserMedia({
      'audio': {
        'echoCancellation': true,
        'noiseSuppression': true,
        'autoGainControl': true,
      },
      'video': false,
    });
    if (_stopped) {
      for (final track in stream.getTracks()) {
        await track.stop();
      }
      await stream.dispose();
      throw StateError('Voice join cancelled');
    }
    _stream = stream;
    if (Platform.isAndroid) await Helper.setSpeakerphoneOnButPreferBluetooth();
  }

  @override
  void configure(
    String participantId,
    List<dynamic> iceServers,
    void Function(String, Json) send,
    void Function(String, String) link,
  ) {
    _id = participantId;
    _iceServers = [
      for (final raw in iceServers)
        {
          if ((raw as Map)['username'] is String) 'username': raw['username'],
          if (raw['credential'] is String) 'credential': raw['credential'],
          'urls': [
            for (final url in raw['urls'] as List)
              if (url is String && RegExp(r'^(?:stun|turn)s?:').hasMatch(url))
                url,
          ],
        },
    ];
    _send = send;
    _link = link;
  }

  @override
  void peers(Set<String> ids) {
    for (final id in _peers.keys.toList()) {
      if (!ids.contains(id)) {
        final peer = _peers.remove(id)!;
        unawaited(_reset(peer));
      }
    }
    for (final id in ids) {
      if (_peers.containsKey(id)) continue;
      final peer = _Peer(id);
      _peers[id] = peer;
      _link?.call(id, 'connecting');
      _timeout(peer);
      if (_id!.compareTo(id) < 0) _enqueue(peer, () => _offer(peer));
    }
  }

  void _enqueue(_Peer peer, Future<void> Function() action) {
    peer.queue = peer.queue
        .then((_) async {
          if (!_stopped && _peers[peer.id] == peer) await action();
        })
        .catchError((Object _) {
          if (!_stopped && _peers[peer.id] == peer) {
            _link?.call(peer.id, 'unavailable');
          }
        });
  }

  Future<RTCPeerConnection> _connection(_Peer peer, String exchangeId) async {
    final pc = await createPeerConnection({
      'iceServers': _iceServers,
      'sdpSemantics': 'unified-plan',
    });
    if (_stopped || _peers[peer.id] != peer) {
      await pc.close();
      throw StateError('Voice participation ended');
    }
    peer.pc = pc;
    peer.exchangeId = exchangeId;
    for (final track in _stream!.getAudioTracks()) {
      await pc.addTrack(track, _stream!);
    }
    pc.onIceCandidate = (candidate) {
      if (candidate.candidate?.isNotEmpty == true && peer.pc == pc) {
        _send?.call(peer.id, {
          'type': 'candidate',
          'exchangeId': exchangeId,
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        });
      }
    };
    pc.onTrack = (event) {
      if (peer.pc != pc) return;
      event.track.enabled = !_deafened;
      peer.remoteTracks.add(event.track);
    };
    pc.onConnectionState = (state) {
      if (peer.pc != pc || _stopped) return;
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        peer.timer?.cancel();
        _link?.call(peer.id, 'connected');
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _link?.call(peer.id, 'unavailable');
      } else if (state ==
          RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        _link?.call(peer.id, 'connecting');
        _timeout(peer);
      }
    };
    return pc;
  }

  Future<void> _offer(_Peer peer) async {
    await _reset(peer);
    final exchangeId = const Uuid().v4();
    final pc = await _connection(peer, exchangeId);
    final offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (peer.pc == pc && !_stopped) {
      _send?.call(peer.id, {
        'type': 'offer',
        'exchangeId': exchangeId,
        'sdp': offer.sdp,
      });
    }
    _timeout(peer);
  }

  @override
  void receive(String fromId, Json signal) {
    final peer = _peers[fromId];
    if (peer == null) return;
    _enqueue(peer, () async {
      final type = signal['type'];
      if (type == 'retry') {
        if (_id!.compareTo(fromId) < 0) await _offer(peer);
      } else if (type == 'offer') {
        if (_id!.compareTo(fromId) < 0) return;
        final waiting = peer.candidates
            .where((c) => c['exchangeId'] == signal['exchangeId'])
            .toList();
        await _reset(peer);
        final pc = await _connection(peer, signal['exchangeId'] as String);
        await pc.setRemoteDescription(
          RTCSessionDescription(signal['sdp'] as String, 'offer'),
        );
        for (final candidate in waiting) {
          await pc.addCandidate(_candidate(candidate));
        }
        final answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (!_stopped && peer.pc == pc) {
          _send?.call(fromId, {
            'type': 'answer',
            'exchangeId': signal['exchangeId'],
            'sdp': answer.sdp,
          });
        }
        _timeout(peer);
      } else if (type == 'answer') {
        if (peer.exchangeId != signal['exchangeId'] || peer.pc == null) return;
        await peer.pc!.setRemoteDescription(
          RTCSessionDescription(signal['sdp'] as String, 'answer'),
        );
        final waiting = peer.candidates;
        peer.candidates = [];
        for (final candidate in waiting) {
          if (candidate['exchangeId'] == signal['exchangeId']) {
            await peer.pc!.addCandidate(_candidate(candidate));
          }
        }
      } else if (type == 'candidate') {
        if (peer.exchangeId == signal['exchangeId'] &&
            peer.pc != null &&
            await peer.pc!.getRemoteDescription() != null) {
          await peer.pc!.addCandidate(_candidate(signal));
        } else if (peer.candidates.length < 64) {
          peer.candidates.add(signal);
        }
      }
    });
  }

  RTCIceCandidate _candidate(Json value) => RTCIceCandidate(
    value['candidate'] as String,
    value['sdpMid'] as String?,
    value['sdpMLineIndex'] as int?,
  );

  @override
  void retry(String id) {
    final peer = _peers[id];
    if (peer == null) return;
    _enqueue(peer, () async {
      await _reset(peer);
      _link?.call(id, 'connecting');
      if (_id!.compareTo(id) < 0) {
        await _offer(peer);
      } else {
        _send?.call(id, {'type': 'retry'});
      }
      _timeout(peer);
    });
  }

  void _timeout(_Peer peer) {
    peer.timer?.cancel();
    if (_stopped) return;
    peer.timer = Timer(const Duration(seconds: 20), () {
      if (_peers[peer.id] == peer &&
          !_stopped &&
          peer.pc?.connectionState !=
              RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _link?.call(peer.id, 'unavailable');
      }
    });
  }

  @override
  void mute(bool muted) {
    for (final track in _stream?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      track.enabled = !muted;
    }
  }

  @override
  void deafen(bool deafened) {
    _deafened = deafened;
    for (final peer in _peers.values) {
      for (final track in peer.remoteTracks) {
        track.enabled = !deafened;
      }
    }
  }

  Future<void> _reset(_Peer peer) async {
    peer.timer?.cancel();
    final pc = peer.pc;
    peer.pc = null;
    peer.exchangeId = null;
    peer.candidates = [];
    peer.remoteTracks = [];
    if (pc != null) {
      pc.onTrack = null;
      pc.onIceCandidate = null;
      pc.onConnectionState = null;
      await pc.close();
      await pc.dispose();
    }
  }

  @override
  Future<void> stop() async {
    _stopped = true;
    final peers = _peers.values.toList();
    _peers.clear();
    _send = null;
    _link = null;
    final stream = _stream;
    _stream = null;
    for (final track in stream?.getTracks() ?? <MediaStreamTrack>[]) {
      await track.stop();
    }
    await stream?.dispose();
    await Future.wait(peers.map(_reset));
  }
}
