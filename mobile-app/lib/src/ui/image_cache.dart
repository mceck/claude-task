import 'package:flutter_cache_manager/flutter_cache_manager.dart';

import '../api.dart';

/// Fetches through the API client so images keep the current Login and the
/// Installation origin check.
class ApiFileService extends FileService {
  final TaskApi api;
  ApiFileService(this.api);

  @override
  Future<FileServiceResponse> get(
    String url, {
    Map<String, String>? headers,
  }) async => BytesResponse(await api.download(url));
}

class BytesResponse implements FileServiceResponse {
  final List<int> bytes;
  BytesResponse(this.bytes);

  @override
  Stream<List<int>> get content => Stream.value(bytes);
  @override
  int? get contentLength => bytes.length;
  @override
  int get statusCode => 200;
  // Image URLs carry a `?v=` version, so a cached copy never goes stale.
  @override
  DateTime get validTill => DateTime.now().add(const Duration(days: 30));
  @override
  String? get eTag => null;
  @override
  String get fileExtension => '';
}

/// Builds the cache for one API client; tests replace it with an in-memory one.
BaseCacheManager Function(TaskApi api) createImageCacheManager = (api) =>
    CacheManager(
      Config(
        'claudeTaskImages',
        stalePeriod: const Duration(days: 30),
        maxNrOfCacheObjects: 200,
        fileService: ApiFileService(api),
      ),
    );

final _managers = Expando<BaseCacheManager>();

BaseCacheManager imageCacheManager(TaskApi api) =>
    _managers[api] ??= createImageCacheManager(api);

/// Cached files are shared on disk, so keys include the Installation.
String imageCacheKey(TaskApi api, String url) => '${api.installation}|$url';
