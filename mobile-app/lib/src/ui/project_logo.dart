import 'package:cached_network_image/cached_network_image.dart';
import 'package:material_ui/material_ui.dart';

import '../api.dart';
import '../models.dart';
import 'image_cache.dart';
import 'widgets.dart';

/// Loads through the cached API client so images use the current Login and origin.
class ProjectLogo extends StatefulWidget {
  final Project project;
  final TaskApi? api;
  final double size;
  final bool selected;

  const ProjectLogo({
    super.key,
    required this.project,
    required this.api,
    this.size = 40,
    this.selected = false,
  });

  @override
  State<ProjectLogo> createState() => _ProjectLogoState();
}

class _ProjectLogoState extends State<ProjectLogo> {
  @override
  Widget build(BuildContext context) {
    final fallback = Avatar(
      label: widget.project.key,
      seed: widget.project.name,
      size: widget.size,
      circle: false,
      initials: false,
      selected: widget.selected,
    );
    final url = widget.project.logoUrl, api = widget.api;
    if (url == null || api == null) return fallback;
    return Semantics(
      image: true,
      label: '${widget.project.name} logo',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(widget.size * .3),
        child: CachedNetworkImage(
          key: ValueKey((api, url)),
          imageUrl: url,
          cacheKey: imageCacheKey(api, url),
          cacheManager: imageCacheManager(api),
          width: widget.size,
          height: widget.size,
          fit: BoxFit.contain,
          fadeInDuration: Duration.zero,
          fadeOutDuration: Duration.zero,
          placeholder: (context, url) => fallback,
          errorWidget: (context, url, error) => fallback,
        ),
      ),
    );
  }
}
