import 'package:flutter/material.dart' as legacy;
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:material_ui/material_ui.dart';

import 'theme.dart';

MarkdownStyleSheet markdownStyle(BuildContext context, {double size = 14.5}) {
  final base = TextStyle(fontSize: size, height: 1.55, color: Palette.fg);
  return MarkdownStyleSheet.fromTheme(legacy.Theme.of(context)).copyWith(
    p: base,
    listBullet: base,
    a: base.copyWith(
      color: Palette.primarySoft,
      decoration: TextDecoration.underline,
      decorationColor: Palette.primarySoft.withValues(alpha: .4),
    ),
    strong: const TextStyle(fontWeight: FontWeight.w600),
    h1: base.copyWith(fontSize: size + 6, fontWeight: FontWeight.w600),
    h2: base.copyWith(fontSize: size + 4, fontWeight: FontWeight.w600),
    h3: base.copyWith(fontSize: size + 2, fontWeight: FontWeight.w600),
    h4: base.copyWith(fontWeight: FontWeight.w600),
    code: TextStyle(
      fontFamily: mono,
      fontSize: size - 1.5,
      color: Palette.code,
      backgroundColor: Palette.muted,
    ),
    codeblockPadding: const EdgeInsets.all(14),
    codeblockDecoration: BoxDecoration(
      color: Palette.sidebar,
      borderRadius: BorderRadius.circular(Radii.md),
      border: Border.all(color: Palette.border),
    ),
    blockquote: base.copyWith(color: Palette.fgMuted),
    blockquotePadding: const EdgeInsets.fromLTRB(14, 4, 8, 4),
    blockquoteDecoration: const BoxDecoration(
      border: Border(left: BorderSide(color: Palette.borderStrong, width: 3)),
    ),
    horizontalRuleDecoration: const BoxDecoration(
      border: Border(top: BorderSide(color: Palette.border)),
    ),
    tableBorder: TableBorder.all(color: Palette.border),
    tableHead: base.copyWith(fontWeight: FontWeight.w600),
    tableBody: base,
    tableCellsPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    blockSpacing: 10,
  );
}

class Md extends StatelessWidget {
  final String data;
  final bool selectable;
  final double size;
  final void Function(String? href)? onLink;
  final void Function(String href, String filename)? onAttachment;
  const Md(
    this.data, {
    super.key,
    this.selectable = true,
    this.size = 14.5,
    this.onLink,
    this.onAttachment,
  });

  void _open(String? href, String label) {
    if (href != null &&
        onAttachment != null &&
        RegExp(r'^/api/v1/attachments/[^/?#]+$').hasMatch(href)) {
      onAttachment!(href, label);
    } else {
      onLink?.call(href);
    }
  }

  @override
  // flutter_markdown_plus still uses the SDK's Material theme and localizations.
  // Keep its compatibility scope here until the package migrates to material_ui.
  // ignore: deprecated_member_use
  Widget build(BuildContext context) => MaterialUiCompatibilityBridge(
    child: Builder(
      builder: (context) => MarkdownBody(
        data: data,
        selectable: selectable,
        styleSheet: markdownStyle(context, size: size),
        onTapLink: (text, href, _) => _open(href, text),
        imageBuilder: (uri, title, alt) => Semantics(
          link: true,
          child: InkWell(
            onTap: onLink == null && onAttachment == null
                ? null
                : () => _open(uri.toString(), alt ?? 'image'),
            borderRadius: BorderRadius.circular(Radii.sm),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: Palette.sidebar,
                borderRadius: BorderRadius.circular(Radii.sm),
                border: Border.all(color: Palette.border),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.image_outlined,
                    size: 18,
                    color: Palette.primarySoft,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      alt == null || alt.isEmpty ? 'Linked image' : alt,
                      style: const TextStyle(
                        color: Palette.fgMuted,
                        fontSize: 13,
                      ),
                    ),
                  ),
                  const Icon(
                    Icons.open_in_new_rounded,
                    size: 14,
                    color: Palette.fgSubtle,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
