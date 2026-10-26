import 'dart:convert';
import 'dart:io';
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
  Future<void> _writes = Future.value();
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
    final root = await supportDirectory();
    final key = sha256
        .convert(utf8.encode('$installation\n$userId'))
        .toString();
    _directory = Directory('${root.path}/claude-task/$key');
    await _directory!.create(recursive: true);
    final file = File('${_directory!.path}/cache.json');
    try {
      _cache = file.existsSync()
          ? jsonDecode(await file.readAsString()) as Json
          : {};
    } on FormatException {
      _cache = {};
    } on FileSystemException {
      _cache = {};
    }
  }

  @override
  Json? read(String key) => _cache[key] == null
      ? null
      : Map<String, dynamic>.from(_cache[key] as Map);
  @override
  Future<void> write(String key, Json value) {
    _cache[key] = value;
    final snapshot = jsonEncode(_cache);
    final directory = _directory;
    // Serialize atomic replacements so drafts can't be overwritten by an older write.
    _writes = _writes.catchError((Object _) {}).then((_) async {
      if (directory == null) return;
      final temporary = File('${directory.path}/cache.tmp');
      await temporary.writeAsString(snapshot, flush: true);
      await temporary.rename('${directory.path}/cache.json');
    });
    return _writes;
  }

  @override
  Future<void> clear() async {
    await _writes.catchError((Object _) {});
    _cache = {};
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
    final copy = await File(
      file.path,
    ).copy('${directory.path}/${const Uuid().v4()}-$safe');
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
