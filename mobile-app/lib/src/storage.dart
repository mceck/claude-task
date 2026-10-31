import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import 'models.dart';

abstract class ProfileStorage {
  Future<Json?> readLogin();
  Future<void> writeLogin(Json? login);
  Future<void> open(String installation, String userId);
  Json? read(String key);
  Future<void> write(String key, Json value);
  Future<void> clear();
  Future<File> attachment(String id, String filename);
  Future<DraftFile> stageAttachment(DraftFile file);
  Future<void> savePendingLogout(Json? login);
  Future<Json?> pendingLogout();
}

class NativeStorage implements ProfileStorage {
  final FlutterSecureStorage secure;
  final Future<Directory> Function() supportDirectory;
  Directory? _directory;
  Json _cache = {};

  /// Every key's value as JSON, encoded once when it is written. The cache
  /// file is these fragments joined: re-encoding the whole profile (Projects,
  /// Task lists, Timelines) on every write, and so on every keystroke of a
  /// draft, made typing and scrolling stutter.
  Map<String, Uint8List> _encoded = {};

  /// Writes run one after another, each replacing the file atomically. Writes
  /// made while one runs share the next, which persists them all.
  Future<void> _writes = Future.value();
  Future<void>? _nextWrite;
  NativeStorage({
    this.secure = const FlutterSecureStorage(
      mOptions: MacOsOptions(usesDataProtectionKeychain: false),
    ),
    Future<Directory> Function()? supportDirectory,
  }) : supportDirectory = supportDirectory ?? getApplicationSupportDirectory;
  @override
  Future<Json?> readLogin() async {
    final value = await secure.read(key: 'login');
    return value == null ? null : jsonDecode(value) as Json;
  }

  @override
  Future<void> writeLogin(Json? login) async {
    if (login == null) {
      await secure.delete(key: 'login');
    } else {
      await secure.write(key: 'login', value: jsonEncode(login));
    }
  }

  @override
  Future<void> open(String installation, String userId) async {
    // Whatever the previous profile still had to write goes to its own folder.
    await _writes.catchError((Object _) {});
    _directory = null;
    final root = await supportDirectory();
    final key = sha256
        .convert(utf8.encode('$installation\n$userId'))
        .toString();
    final directory = Directory('${root.path}/claude-task/$key');
    await directory.create(recursive: true);
    final path = '${directory.path}/cache.json';
    // A large cache would hold the UI while it decodes.
    final (cache, encoded) = await Isolate.run(() => _load(path));
    _directory = directory;
    _cache = cache;
    _encoded = encoded;
  }

  @override
  Json? read(String key) => _cache[key] == null
      ? null
      : Map<String, dynamic>.from(_cache[key] as Map);
  @override
  Future<void> write(String key, Json value) {
    _cache[key] = value;
    _encoded[key] = _encode(value);
    final directory = _directory;
    if (directory == null) return Future.value();
    return _nextWrite ??= _writes = _writes.catchError((Object _) {}).then((
      _,
    ) async {
      // From here on, writes need another round: this one has their values.
      _nextWrite = null;
      final snapshot = _snapshot();
      final temporary = File('${directory.path}/cache.tmp');
      await temporary.writeAsBytes(snapshot, flush: true);
      await temporary.rename('${directory.path}/cache.json');
    });
  }

  Uint8List _snapshot() {
    final bytes = BytesBuilder(copy: false)..addByte(0x7b); // {
    var first = true;
    for (final MapEntry(:key, :value) in _encoded.entries) {
      if (!first) bytes.addByte(0x2c); // ,
      first = false;
      bytes
        ..add(_encode(key))
        ..addByte(0x3a) // :
        ..add(value);
    }
    bytes.addByte(0x7d); // }
    return bytes.takeBytes();
  }

  @override
  Future<void> clear() async {
    await _writes.catchError((Object _) {});
    _cache = {};
    _encoded = {};
    if (_directory != null && await _directory!.exists()) {
      await _directory!.delete(recursive: true);
    }
    _directory = null;
    await writeLogin(null);
  }

  @override
  Future<File> attachment(String id, String filename) async {
    if (_directory == null) throw StateError('No active profile');
    final folder = Directory('${_directory!.path}/attachments');
    await folder.create(recursive: true);
    final safe = filename.replaceAll(RegExp(r'[^a-zA-Z0-9._-]'), '_');
    final key = sha256.convert(utf8.encode(id)).toString();
    return File('${folder.path}/$key-$safe');
  }

  @override
  Future<DraftFile> stageAttachment(DraftFile file) async {
    if (_directory == null) throw StateError('No active profile');
    final directory = Directory('${_directory!.path}/draft-files');
    await directory.create(recursive: true);
    final safe = file.name.replaceAll(RegExp(r'[^a-zA-Z0-9._-]'), '_');
    final copy = await File(file.path)
        .copy('${directory.path}/${const Uuid().v4()}-$safe');
    return DraftFile(copy.path, file.name);
  }

  @override
  Future<void> savePendingLogout(Json? login) async {
    if (login == null) {
      await secure.delete(key: 'pendingLogout');
    } else {
      await secure.write(key: 'pendingLogout', value: jsonEncode(login));
    }
  }

  @override
  Future<Json?> pendingLogout() async {
    final value = await secure.read(key: 'pendingLogout');
    return value == null ? null : jsonDecode(value) as Json;
  }
}

Uint8List _encode(Object? value) {
  final bytes = JsonUtf8Encoder().convert(value);
  return bytes is Uint8List ? bytes : Uint8List.fromList(bytes);
}

/// Reads a profile's cache file, with each key's value already encoded for
/// the next write. Runs on a background isolate.
(Json, Map<String, Uint8List>) _load(String path) {
  Json cache;
  try {
    final file = File(path);
    cache = file.existsSync()
        ? jsonDecode(file.readAsStringSync()) as Json
        : {};
  } on FormatException {
    cache = {};
  } on FileSystemException {
    cache = {};
  }
  return (
    cache,
    {for (final MapEntry(:key, :value) in cache.entries) key: _encode(value)},
  );
}
