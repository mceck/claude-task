import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';

import '../api.dart';
import 'widgets.dart';

// Share downloads across Comments and profile controls, scoped to this Login's API.
final _images = Expando<Map<String, Future<Uint8List>>>();

Future<Uint8List> _download(TaskApi api, String url) {
  final cache = _images[api] ??= {};
  return cache[url] ??= () {
    if (cache.length >= 32) cache.remove(cache.keys.first);
    return api.download(url).catchError((Object error) {
      cache.remove(url);
      throw error;
    });
  }();
}

/// Profile pictures use the authenticated API and its Installation origin check.
class UserAvatar extends StatefulWidget {
  final String label;
  final String? userId, imageUrl, emoji;
  final TaskApi? api;
  final double size;
  final bool selected, circle;

  const UserAvatar({
    super.key,
    required this.label,
    required this.api,
    this.userId,
    this.imageUrl,
    this.emoji,
    this.size = 36,
    this.selected = false,
    this.circle = true,
  });

  @override
  State<UserAvatar> createState() => _UserAvatarState();
}

class _UserAvatarState extends State<UserAvatar> {
  Future<Uint8List>? _image;

  void _load() {
    final url = widget.imageUrl;
    final api = widget.api;
    _image = url == null || api == null ? null : _download(api, url);
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(UserAvatar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.imageUrl != widget.imageUrl || oldWidget.api != widget.api) {
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final fallback = Avatar(
      label: widget.label,
      emoji: widget.emoji,
      seed: widget.userId,
      size: widget.size,
      circle: widget.circle,
      selected: widget.selected,
    );
    return Semantics(
      image: true,
      label: '${widget.label} avatar',
      child: _image == null
          ? fallback
          : FutureBuilder<Uint8List>(
              key: ValueKey((widget.api, widget.imageUrl)),
              future: _image,
              builder: (context, snapshot) {
                if (!snapshot.hasData) return fallback;
                final image = Image.memory(
                  snapshot.data!,
                  width: widget.size,
                  height: widget.size,
                  fit: BoxFit.cover,
                  excludeFromSemantics: true,
                  errorBuilder: (context, error, stackTrace) => fallback,
                );
                return widget.circle
                    ? ClipOval(child: image)
                    : ClipRRect(
                        borderRadius: BorderRadius.circular(widget.size * .3),
                        child: image,
                      );
              },
            ),
    );
  }
}
