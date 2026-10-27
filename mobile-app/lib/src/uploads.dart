import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:material_ui/material_ui.dart';

import 'models.dart';
import 'ui/widgets.dart';

const _imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

Future<DraftFile> _localFile(
  PlatformFile selected,
  int maxBytes, {
  bool requireContent = false,
}) async {
  final path = selected.path;
  if (path == null) {
    throw const FormatException('The selected file is unavailable');
  }
  final size = await selected.length() ?? await File(path).length();
  if (size > maxBytes) {
    throw FormatException(
      '${selected.name} must be at most ${maxBytes ~/ (1024 * 1024)} MB',
    );
  }
  if (requireContent && size == 0) {
    throw const FormatException('The selected image is empty');
  }
  return DraftFile(path, selected.name);
}

Future<DraftFile?> pickAppImage() async {
  final selected = await FilePicker.pickFile(
    type: FileType.custom,
    allowedExtensions: _imageExtensions,
  );
  if (selected == null) return null;
  if (!_imageExtensions.contains(selected.extension?.toLowerCase())) {
    throw const FormatException('Choose a PNG, JPEG, GIF or WebP image');
  }
  return _localFile(selected, 2 * 1024 * 1024, requireContent: true);
}

Future<List<DraftFile>> pickAppAttachments(
  BuildContext context, {
  int maxFiles = 10,
}) async {
  final type = await showAppSheet<FileType>(
    context,
    maxWidth: 400,
    builder: (sheet) => SheetScaffold(
      title: 'Attach images or files',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          AppButton(
            label: 'Images',
            icon: Icons.image_outlined,
            tone: Tone.secondary,
            onPressed: () => Navigator.pop(sheet, FileType.image),
          ),
          const SizedBox(height: 12),
          AppButton(
            label: 'Files',
            icon: Icons.attach_file_rounded,
            tone: Tone.secondary,
            onPressed: () => Navigator.pop(sheet, FileType.any),
          ),
        ],
      ),
    ),
  );
  if (type == null) return [];
  final selected = await FilePicker.pickFiles(type: type);
  if (selected.length > maxFiles) {
    throw const FormatException('At most 10 files, 25 MB each');
  }
  return Future.wait(
    selected.map((file) => _localFile(file, 25 * 1024 * 1024)),
  );
}

String attachmentMarkdown(Json attachment) {
  final name = (attachment['filename'] as String).replaceAllMapped(
    RegExp(r'[\[\]\\]'),
    (match) => '\\${match[0]}',
  );
  final image = const [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
  ].contains(attachment['contentType']);
  return '${image ? '!' : ''}[$name](${attachment['url']})';
}
