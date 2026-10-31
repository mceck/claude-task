import 'package:cached_network_image/cached_network_image.dart';
import 'package:material_ui/material_ui.dart';

import '../api.dart';
import 'image_cache.dart';
import 'widgets.dart';

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
    final url = widget.imageUrl, api = widget.api;
    return Semantics(
      image: true,
      label: '${widget.label} avatar',
      child: url == null || api == null ? fallback : _image(api, url, fallback),
    );
  }

  Widget _image(TaskApi api, String url, Widget fallback) {
    final image = CachedNetworkImage(
      key: ValueKey((api, url)),
      imageUrl: url,
      cacheKey: imageCacheKey(api, url),
      cacheManager: imageCacheManager(api),
      width: widget.size,
      height: widget.size,
      fit: BoxFit.cover,
      fadeInDuration: Duration.zero,
      fadeOutDuration: Duration.zero,
      placeholder: (context, url) => fallback,
      errorWidget: (context, url, error) => fallback,
    );
    return widget.circle
        ? ClipOval(child: image)
        : ClipRRect(
            borderRadius: BorderRadius.circular(widget.size * .3),
            child: image,
          );
  }
}
