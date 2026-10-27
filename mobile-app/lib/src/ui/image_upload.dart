import 'package:material_ui/material_ui.dart';

import '../models.dart';
import '../uploads.dart';
import 'theme.dart';
import 'widgets.dart';

class ImageUpload extends StatefulWidget {
  final String title, uploadLabel, replaceLabel, removeLabel;
  final String? imageUrl;
  final bool enabled;
  final Widget Function(String? url) preview;
  final Future<String?> Function(DraftFile? file) onChange;

  const ImageUpload({
    super.key,
    required this.title,
    required this.uploadLabel,
    required this.replaceLabel,
    required this.removeLabel,
    required this.imageUrl,
    required this.preview,
    required this.onChange,
    this.enabled = true,
  });

  @override
  State<ImageUpload> createState() => _ImageUploadState();
}

class _ImageUploadState extends State<ImageUpload> {
  late String? _url = widget.imageUrl;
  String? _error;
  bool _saving = false;

  @override
  void didUpdateWidget(ImageUpload oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.imageUrl != widget.imageUrl && !_saving) {
      _url = widget.imageUrl;
    }
  }

  Future<void> _change({bool remove = false}) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final file = remove ? null : await pickAppImage();
      if (!remove && file == null) return;
      if (!mounted) return;
      final url = await widget.onChange(file);
      if (mounted) setState(() => _url = url);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => LabeledField(
    label: widget.title,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            widget.preview(_url),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'PNG, JPEG, GIF or WebP · up to 2 MB',
                    style: TextStyle(fontSize: 12, color: Palette.fgSubtle),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      AppButton(
                        label: _url == null
                            ? widget.uploadLabel
                            : widget.replaceLabel,
                        icon: Icons.upload_rounded,
                        tone: Tone.secondary,
                        compact: true,
                        busy: _saving,
                        onPressed: widget.enabled && !_saving ? _change : null,
                      ),
                      if (_url != null)
                        AppButton(
                          label: widget.removeLabel,
                          icon: Icons.delete_outline_rounded,
                          tone: Tone.danger,
                          compact: true,
                          onPressed: widget.enabled && !_saving
                              ? () => _change(remove: true)
                              : null,
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
        if (_error != null) ...[
          const SizedBox(height: 10),
          Notice.error(_error!),
        ],
      ],
    ),
  );
}
