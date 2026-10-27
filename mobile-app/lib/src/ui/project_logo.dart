import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';

import '../api.dart';
import '../models.dart';
import 'widgets.dart';

/// Downloads through the API client so images use the current Login and origin.
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
  Future<Uint8List>? _image;

  void _load() {
    final url = widget.project.logoUrl;
    _image = url == null ? null : widget.api?.download(url);
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(ProjectLogo oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.project.logoUrl != widget.project.logoUrl ||
        oldWidget.api != widget.api) {
      _load();
    }
  }

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
    if (_image == null) return fallback;
    return FutureBuilder<Uint8List>(
      key: ValueKey((widget.api, widget.project.logoUrl)),
      future: _image,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return fallback;
        return ClipRRect(
          borderRadius: BorderRadius.circular(widget.size * .3),
          child: Image.memory(
            snapshot.data!,
            width: widget.size,
            height: widget.size,
            fit: BoxFit.contain,
            semanticLabel: '${widget.project.name} logo',
            errorBuilder: (context, error, stackTrace) => fallback,
          ),
        );
      },
    );
  }
}
