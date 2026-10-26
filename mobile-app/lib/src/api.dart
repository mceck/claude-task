import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'package:mime/mime.dart';
import 'package:http_parser/http_parser.dart';
import 'models.dart';

class ApiException implements Exception {
  final int status;
  final String code, message;
  final Json data;
  const ApiException(
    this.status,
    this.code,
    this.message, [
    this.data = const {},
  ]);
  @override
  String toString() => message;
}

abstract class TaskApi {
  Uri get installation;
  String? get cookie;
  set cookie(String? value);
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  });
  Future<Uint8List> download(String path);
  void close();
}

Uri installationUrl(String value) {
  final uri = Uri.tryParse(value.trim());
  if (uri == null ||
      !['https', 'http'].contains(uri.scheme) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path != '' && uri.path != '/')) {
    throw const FormatException(
      'Enter an installation URL such as https://tasks.example.com',
    );
  }
  return uri.replace(path: '');
}

class HttpTaskApi implements TaskApi {
  @override
  final Uri installation;
  @override
  String? cookie;
  final http.Client _client;
  final Future<void> Function(String cookie)? onCookie;
  HttpTaskApi(
    this.installation, {
    this.cookie,
    this.onCookie,
    http.Client? client,
  }) : _client = client ?? http.Client();
  Uri _uri(String path) {
    final uri = installation.resolve(
      path.startsWith('/api/') ? path : '/api/v1$path',
    );
    if (uri.origin != installation.origin || !uri.path.startsWith('/api/v1/')) {
      throw const FormatException('Untrusted API URL');
    }
    return uri;
  }

  Map<String, String> get _headers => {'x-claude-task': '1', 'cookie': ?cookie};
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    http.BaseRequest request;
    if (files.isNotEmpty) {
      final multipart = http.MultipartRequest(method, _uri(path));
      for (final entry in (body ?? {}).entries) {
        multipart.fields[entry.key] = entry.value.toString();
      }
      for (final file in files) {
        multipart.files.add(
          await http.MultipartFile.fromPath(
            'files',
            file.path,
            filename: file.name,
            contentType: MediaType.parse(
              lookupMimeType(file.name) ?? 'application/octet-stream',
            ),
          ),
        );
      }
      request = multipart;
    } else {
      final plain = http.Request(method, _uri(path));
      if (body != null) {
        plain.headers['content-type'] = 'application/json';
        plain.body = jsonEncode(body);
      }
      request = plain;
    }
    request.headers.addAll(_headers);
    final response = await http.Response.fromStream(
      await _client.send(request).timeout(const Duration(seconds: 30)),
    ).timeout(const Duration(seconds: 30));
    // Native clients handle HttpOnly cookies explicitly and keep them in secure storage.
    final setCookie = response.headers['set-cookie'];
    if (setCookie != null) {
      final match = RegExp(r'ct_login=([^;,]*)').firstMatch(setCookie);
      if (match != null) {
        cookie = match.group(1)!.isEmpty ? null : 'ct_login=${match.group(1)}';
        if (cookie != null) await onCookie?.call(cookie!);
      }
    }
    final data = response.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(response.body) as Json;
    if (response.statusCode >= 400) {
      final error = data['error'] as Map? ?? {};
      throw ApiException(
        response.statusCode,
        error['code'] as String? ?? 'request_failed',
        error['message'] as String? ?? 'Request failed',
        data,
      );
    }
    return data;
  }

  @override
  Future<Uint8List> download(String path) async {
    final response = await _client
        .get(_uri(path), headers: _headers)
        .timeout(const Duration(seconds: 30));
    if (response.statusCode != 200) {
      throw ApiException(
        response.statusCode,
        'download_failed',
        'Attachment download failed',
      );
    }
    return response.bodyBytes;
  }

  @override
  void close() => _client.close();
}

enum ConnectionState { offline, connecting, connected }

abstract class LiveConnection {
  Stream<Json> get events;
  Stream<ConnectionState> get states;
  void subscribe(Set<String> topics);
  void connect();
  void close();
}

class TaskSocket implements LiveConnection {
  final TaskApi api;
  final _events = StreamController<Json>.broadcast();
  final _states = StreamController<ConnectionState>.broadcast();
  WebSocket? _socket;
  Timer? _timer;
  Set<String> _topics = {};
  bool _closed = false, _connecting = false;
  int _attempt = 0;
  TaskSocket(this.api);
  @override
  Stream<Json> get events => _events.stream;
  @override
  Stream<ConnectionState> get states => _states.stream;
  @override
  void subscribe(Set<String> topics) {
    final removed = _topics.difference(topics);
    if (_socket != null && removed.isNotEmpty) {
      _socket!.add(
        jsonEncode({'type': 'unsubscribe', 'topics': removed.toList()}),
      );
    }
    _topics = topics;
    _sendSubscriptions();
  }

  void _sendSubscriptions() => _socket?.add(
    jsonEncode({'type': 'subscribe', 'topics': _topics.toList()}),
  );
  @override
  void connect() {
    if (_connecting || _socket != null || _closed) return;
    unawaited(_open());
  }

  Future<void> _open() async {
    _timer?.cancel();
    _connecting = true;
    _states.add(ConnectionState.connecting);
    try {
      final uri = api.installation.replace(
        scheme: api.installation.scheme == 'https' ? 'wss' : 'ws',
        path: '/api/v1/ws',
      );
      final socket = await WebSocket.connect(
        uri.toString(),
        headers: {if (api.cookie != null) 'cookie': api.cookie!},
      ).timeout(const Duration(seconds: 15));
      if (_closed) {
        await socket.close();
        return;
      }
      _socket = socket;
      _attempt = 0;
      socket.listen(
        (raw) {
          final message = jsonDecode(raw as String) as Json;
          if (message['type'] == 'subscribed') {
            _states.add(ConnectionState.connected);
          }
          if (message['type'] == 'event') {
            _events.add(Map<String, dynamic>.from(message['event'] as Map));
          }
        },
        onDone: () {
          if (socket.closeCode == 4001) _events.add({'type': 'login.expired'});
          _lost();
        },
        onError: (_) => _lost(),
        cancelOnError: true,
      );
      _sendSubscriptions();
    } catch (_) {
      _lost();
    } finally {
      _connecting = false;
    }
  }

  void _lost() {
    _socket = null;
    if (_closed) return;
    _states.add(ConnectionState.offline);
    _timer?.cancel();
    _timer = Timer(Duration(seconds: 1 << (_attempt++).clamp(0, 5)), connect);
  }

  @override
  void close() {
    _closed = true;
    _timer?.cancel();
    unawaited(_socket?.close());
    _socket = null;
  }
}
