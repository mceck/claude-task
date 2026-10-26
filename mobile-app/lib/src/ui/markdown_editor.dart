import 'dart:async';

import 'package:fleather/fleather.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'markdown.dart';
import 'markdown_document.dart';
import 'theme.dart';
import 'widgets.dart';

enum _Mode { write, markdown, preview }

/// A visual Markdown field sharing the form's plain-text controller. Merely
/// opening it, moving the caret or previewing never rewrites the source.
class MarkdownEditor extends StatefulWidget {
  final TextEditingController controller;
  final bool enabled;
  final String hintText;

  const MarkdownEditor({
    super.key,
    required this.controller,
    this.enabled = true,
    this.hintText = 'Add context, acceptance criteria, links…',
  });

  @override
  State<MarkdownEditor> createState() => _MarkdownEditorState();
}

class _MarkdownEditorState extends State<MarkdownEditor> {
  final _focus = FocusNode(debugLabel: 'Task description');
  final _toolbarScroll = ScrollController();
  final _retired = <FleatherController>[];
  FleatherController? _rich;
  Delta? _lastDelta;
  var _mode = _Mode.write;
  var _syncing = false;
  var _focused = false;
  var _sourceOnly = false;
  String? _loadedSource;
  Timer? _historyRefresh;

  @override
  void initState() {
    super.initState();
    _load();
    if (_sourceOnly) _mode = _Mode.markdown;
    widget.controller.addListener(_sourceChanged);
  }

  @override
  void didUpdateWidget(MarkdownEditor oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_sourceChanged);
      widget.controller.addListener(_sourceChanged);
      _load();
      if (_sourceOnly) _mode = _Mode.markdown;
    }
  }

  void _load() {
    final old = _rich;
    old?.removeListener(_richChanged);
    if (old != null) {
      _retired.add(old);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_retired.remove(old)) old.dispose();
      });
    }
    _rich = null;
    try {
      _rich = _MarkdownController(
        document: MarkdownDocument.decode(widget.controller.text),
        autoFormats: AutoFormats(
          autoFormats: [
            const _MarkdownAutoFormat(AutoFormatLinks()),
            const _MarkdownAutoFormat(MarkdownInlineShortcuts()),
            const _MarkdownAutoFormat(
              MarkdownLineShortcuts(),
              plainLineOnly: true,
            ),
          ],
        ),
      );
      _lastDelta = _rich!.document.toDelta();
      _rich!.addListener(_richChanged);
      _sourceOnly = false;
    } on FormatException {
      _sourceOnly = true;
    }
    _loadedSource = widget.controller.text;
  }

  void _sourceChanged() {
    if (_syncing || !mounted || _loadedSource == widget.controller.text) return;
    setState(() {
      if (_mode == _Mode.write) {
        _load();
        if (_sourceOnly) _mode = _Mode.markdown;
      }
    });
  }

  void _richChanged() {
    final delta = _rich!.document.toDelta();
    if (delta != _lastDelta) {
      _lastDelta = delta;
      _syncing = true;
      final source = MarkdownDocument.encode(_rich!.document);
      _loadedSource = source;
      widget.controller.text = source;
      _syncing = false;
      // Fleather records undo history after a 500 ms typing pause without
      // notifying listeners. Refresh the toolbar once that snapshot is ready.
      _historyRefresh?.cancel();
      _historyRefresh = Timer(const Duration(milliseconds: 550), () {
        if (mounted) setState(() {});
      });
    }
    if (mounted) setState(() {});
  }

  void _switchMode(_Mode mode) {
    if (_mode == mode) return;
    _focus.unfocus();
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {
      if (mode == _Mode.write && _loadedSource != widget.controller.text) {
        _load();
      }
      _mode = mode == _Mode.write && _sourceOnly ? _Mode.markdown : mode;
    });
  }

  @override
  void dispose() {
    _historyRefresh?.cancel();
    widget.controller.removeListener(_sourceChanged);
    _rich?.removeListener(_richChanged);
    _rich?.dispose();
    for (final controller in _retired) {
      controller.dispose();
    }
    _retired.clear();
    _focus.dispose();
    _toolbarScroll.dispose();
    super.dispose();
  }

  void _format(ParchmentAttribute attribute) {
    final style = _rich!.getSelectionStyle();
    _rich!.formatSelection(
      style.containsSame(attribute) ? attribute.unset : attribute,
    );
    _focus.requestFocus();
  }

  Future<void> _link() async {
    final rich = _rich!;
    var selection = rich.selection;
    final existing = rich.getSelectionStyle().value(ParchmentAttribute.link);
    if (selection.isCollapsed && existing != null) {
      var offset = 0;
      int? start;
      final caret = selection.start == 0 ? 0 : selection.start - 1;
      for (final operation in rich.document.toDelta().toList()) {
        final linked =
            operation.attributes?[ParchmentAttribute.link.key] == existing;
        if (linked) start ??= offset;
        if (!linked && start != null) {
          if (caret >= start && caret < offset) {
            selection = TextSelection(baseOffset: start, extentOffset: offset);
            break;
          }
          start = null;
        }
        offset += operation.length;
      }
    }
    final picked = await _showTextDialog(
      context,
      title: existing == null ? 'Insert link' : 'Edit link',
      label: 'URL',
      value: existing ?? '',
      hint: 'https://…',
      validate: (value) =>
          value.isEmpty || _safeUrl(value) ? null : 'Enter a valid link.',
    );
    if (picked == null || !mounted || rich != _rich || !widget.enabled) return;
    if (selection.isCollapsed && existing == null && picked.isNotEmpty) {
      rich.replaceText(
        selection.start,
        0,
        picked,
        selection: TextSelection(
          baseOffset: selection.start,
          extentOffset: selection.start + picked.length,
        ),
      );
      rich.formatSelection(ParchmentAttribute.link.fromString(picked));
    } else {
      rich.formatText(
        selection.start,
        selection.end - selection.start,
        picked.isEmpty
            ? ParchmentAttribute.link.unset
            : ParchmentAttribute.link.fromString(picked),
      );
    }
    _focus.requestFocus();
  }

  Future<void> _insert(String kind, [EmbedNode? node]) async {
    final rich = _rich!;
    final selection = rich.selection;
    final initial = node?.value;
    EmbeddableObject? embed;
    if (kind == 'hr') {
      embed = BlockEmbed.horizontalRule;
    } else if (kind == 'image') {
      final source = await _showTextDialog(
        context,
        title: 'Insert image',
        label: 'Image URL',
        value: '',
        hint: 'https://…',
        validate: (value) => value.isNotEmpty && _safeUrl(value, image: true)
            ? null
            : 'Enter an image URL.',
      );
      if (source != null) embed = BlockEmbed.image(source);
    } else if (kind == 'code') {
      embed = await showAppSheet<BlockEmbed>(
        context,
        dismissible: false,
        maxWidth: 600,
        builder: (_) => _CodeDialog(initial: initial),
      );
    } else {
      final source = await _showTextDialog(
        context,
        title: 'Table',
        label: 'Markdown',
        value:
            initial?.data['markdown'] as String? ??
            '| Column | Column |\n| --- | --- |\n| Text | Text |',
        multiline: true,
      );
      if (source != null && source.trim().isNotEmpty) {
        // Block Markdown stays intact when surrounding rich text is edited.
        embed = MarkdownDocument.markdownBlock(source, kind);
      }
    }
    if (embed == null || !mounted || rich != _rich || !widget.enabled) return;
    if (node != null) {
      // Replacing a block through insert heuristics introduces an empty line.
      // Its existing newline already gives this embed a valid block boundary.
      rich.compose(
        Delta()
          ..retain(node.documentOffset)
          ..insert(embed.toJson())
          ..delete(1),
        source: ChangeSource.local,
        selection: TextSelection.collapsed(offset: node.documentOffset + 1),
      );
    } else {
      rich.replaceText(
        selection.start,
        selection.end - selection.start,
        embed,
        selection: TextSelection.collapsed(offset: selection.start + 1),
      );
    }
    _focus.requestFocus();
  }

  Widget _embed(BuildContext context, EmbedNode node) {
    final embed = node.value;
    if (embed.type == 'hr') return defaultFleatherEmbedBuilder(context, node);
    if (embed.type == 'image') {
      final alt = embed.data['alt'] as String?;
      return Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Palette.sidebar,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            const Icon(
              Icons.image_outlined,
              size: 20,
              color: Palette.primarySoft,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                alt == null || alt.isEmpty ? 'Linked image' : alt,
                style: const TextStyle(fontSize: 13, color: Palette.fgMuted),
              ),
            ),
          ],
        ),
      );
    }
    final kind = embed.data['kind'] as String;
    if (kind == 'code') {
      final language = embed.data['language'] as String? ?? '';
      return Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        decoration: BoxDecoration(
          color: Palette.sidebar,
          border: Border.all(color: Palette.border),
          borderRadius: BorderRadius.circular(Radii.sm),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 12, right: 4),
              child: Row(
                children: [
                  const Icon(
                    Icons.code_rounded,
                    size: 15,
                    color: Palette.fgSubtle,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      language.isEmpty ? 'Code' : language,
                      style: const TextStyle(
                        fontFamily: mono,
                        fontSize: 11.5,
                        color: Palette.fgMuted,
                      ),
                    ),
                  ),
                  TextButton(
                    onPressed: widget.enabled
                        ? () => _insert(kind, node)
                        : null,
                    style: TextButton.styleFrom(
                      foregroundColor: Palette.fgMuted,
                      textStyle: const TextStyle(
                        fontFamily: 'Geist',
                        fontSize: 12,
                      ),
                    ),
                    child: const Text('Edit code'),
                  ),
                ],
              ),
            ),
            const Divider(),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.all(12),
              child: Text(
                (embed.data['code'] as String).replaceFirst(RegExp(r'\n$'), ''),
                style: const TextStyle(
                  fontFamily: mono,
                  fontSize: 12.5,
                  height: 1.65,
                  color: Palette.fg,
                ),
              ),
            ),
          ],
        ),
      );
    }
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: Palette.sidebar,
        border: Border.all(color: Palette.border),
        borderRadius: BorderRadius.circular(Radii.sm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(10),
            child: Md(
              embed.data['markdown'] as String,
              selectable: false,
              size: 13,
            ),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: widget.enabled ? () => _insert(kind, node) : null,
              icon: const Icon(Icons.table_chart_outlined, size: 15),
              label: const Text('Edit table'),
              style: TextButton.styleFrom(
                foregroundColor: Palette.fgMuted,
                textStyle: const TextStyle(fontFamily: 'Geist', fontSize: 12),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _tool(
    IconData icon,
    String label,
    VoidCallback? action, {
    bool active = false,
  }) => IconButton(
    tooltip: label,
    onPressed: widget.enabled ? action : null,
    isSelected: active,
    style: IconButton.styleFrom(
      foregroundColor: active ? Palette.primarySoft : Palette.fgMuted,
      backgroundColor: active
          ? Palette.primary.withValues(alpha: .13)
          : Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      minimumSize: const Size(44, 44),
      padding: const EdgeInsets.all(10),
    ),
    icon: Icon(icon, size: 19),
  );

  Widget _toolbar() {
    final style = _rich!.getSelectionStyle();
    Widget format(IconData icon, String label, ParchmentAttribute attribute) =>
        _tool(
          icon,
          label,
          () => _format(attribute),
          active: style.containsSame(attribute),
        );
    return Scrollbar(
      controller: _toolbarScroll,
      thumbVisibility: true,
      thickness: 2,
      radius: const Radius.circular(2),
      child: SingleChildScrollView(
        controller: _toolbarScroll,
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
        child: Row(
          children: [
            _tool(
              Icons.undo_rounded,
              'Undo',
              _rich!.canUndo ? _rich!.undo : null,
            ),
            _tool(
              Icons.redo_rounded,
              'Redo',
              _rich!.canRedo ? _rich!.redo : null,
            ),
            const SizedBox(height: 22, child: VerticalDivider(width: 12)),
            PopupMenuButton<int>(
              tooltip: 'Text style',
              enabled: widget.enabled,
              onSelected: (level) {
                _rich!.formatSelection(
                  ParchmentAttribute.heading.withValue(
                    level == 0 ? null : level,
                  ),
                );
                _focus.requestFocus();
              },
              itemBuilder: (_) => [
                const PopupMenuItem(value: 0, child: Text('Paragraph')),
                for (var i = 1; i <= 6; i++)
                  PopupMenuItem(value: i, child: Text('Heading $i')),
              ],
              child: const SizedBox(
                width: 44,
                height: 44,
                child: Icon(Icons.title_rounded, size: 20),
              ),
            ),
            format(Icons.format_bold_rounded, 'Bold', ParchmentAttribute.bold),
            format(
              Icons.format_italic_rounded,
              'Italic',
              ParchmentAttribute.italic,
            ),
            format(
              Icons.strikethrough_s_rounded,
              'Strikethrough',
              ParchmentAttribute.strikethrough,
            ),
            format(
              Icons.code_rounded,
              'Inline code',
              ParchmentAttribute.inlineCode,
            ),
            const SizedBox(height: 22, child: VerticalDivider(width: 12)),
            format(
              Icons.format_list_bulleted_rounded,
              'Bullet list',
              ParchmentAttribute.ul,
            ),
            format(
              Icons.format_list_numbered_rounded,
              'Numbered list',
              ParchmentAttribute.ol,
            ),
            format(Icons.checklist_rounded, 'Checklist', ParchmentAttribute.cl),
            format(Icons.format_quote_rounded, 'Quote', ParchmentAttribute.bq),
            _tool(
              Icons.link_rounded,
              'Insert link',
              _link,
              active: style.contains(ParchmentAttribute.link),
            ),
            PopupMenuButton<String>(
              tooltip: 'Insert block',
              enabled: widget.enabled,
              onSelected: _insert,
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'code', child: Text('Code block')),
                PopupMenuItem(value: 'table', child: Text('Table')),
                PopupMenuItem(value: 'image', child: Text('Image by URL')),
                PopupMenuItem(value: 'hr', child: Text('Divider')),
              ],
              child: const SizedBox(
                width: 44,
                height: 44,
                child: Icon(Icons.add_rounded, size: 20),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Focus(
    onFocusChange: (value) => setState(() => _focused = value),
    child: AnimatedContainer(
      duration: Motion.fast,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Palette.surface,
        borderRadius: BorderRadius.circular(Radii.md),
        border: Border.all(
          color: _focused ? Palette.primary : Palette.border,
          width: _focused ? 1.4 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            color: Palette.raised,
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
            child: Row(
              children: [
                for (final mode in _Mode.values)
                  Expanded(
                    child: Semantics(
                      selected: _mode == mode,
                      child: TextButton(
                        onPressed: () => _switchMode(mode),
                        style: TextButton.styleFrom(
                          foregroundColor: _mode == mode
                              ? Palette.fg
                              : Palette.fgMuted,
                          backgroundColor: _mode == mode
                              ? Palette.hover
                              : Colors.transparent,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 10,
                          ),
                          minimumSize: const Size(0, 40),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                          textStyle: const TextStyle(
                            fontFamily: 'Geist',
                            fontSize: 12.5,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        child: Text(switch (mode) {
                          _Mode.write => 'Write',
                          _Mode.markdown => 'Markdown',
                          _Mode.preview => 'Preview',
                        }),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const Divider(),
          if (_mode == _Mode.write && _rich != null) ...[
            _toolbar(),
            const Divider(),
            FleatherTheme(
              data: _editorTheme(context),
              child: Stack(
                children: [
                  if (_rich!.document.toPlainText().trim().isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(14),
                      child: IgnorePointer(
                        child: Text(
                          widget.hintText,
                          style: const TextStyle(
                            color: Palette.fgSubtle,
                            fontSize: 14.5,
                          ),
                        ),
                      ),
                    ),
                  FleatherEditor(
                    key: ObjectKey(_rich),
                    controller: _rich!,
                    focusNode: _focus,
                    readOnly: !widget.enabled,
                    minHeight: 160,
                    maxHeight: 320,
                    padding: const EdgeInsets.all(14),
                    embedBuilder: _embed,
                    onLaunchUrl: _launch,
                  ),
                ],
              ),
            ),
          ] else if (_mode == _Mode.markdown) ...[
            if (_sourceOnly)
              const Padding(
                padding: EdgeInsets.fromLTRB(14, 12, 14, 0),
                child: Text(
                  'This formatting can be edited in Markdown and viewed in Preview.',
                  style: TextStyle(color: Palette.fgMuted, fontSize: 12.5),
                ),
              ),
            TextField(
              key: const Key('description-markdown-source'),
              controller: widget.controller,
              enabled: widget.enabled,
              minLines: 6,
              maxLines: 14,
              style: const TextStyle(
                fontFamily: mono,
                fontSize: 13,
                height: 1.65,
              ),
              autocorrect: false,
              enableSuggestions: false,
              keyboardType: TextInputType.multiline,
              decoration: InputDecoration(
                hintText: widget.hintText,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
              ),
            ),
          ] else
            ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 160, maxHeight: 320),
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(14),
                child: widget.controller.text.trim().isEmpty
                    ? const Text(
                        'Nothing to preview yet.',
                        style: TextStyle(color: Palette.fgSubtle),
                      )
                    : Md(widget.controller.text, onLink: _launch),
              ),
            ),
        ],
      ),
    ),
  );
}

class _MarkdownAutoFormat extends AutoFormat {
  final AutoFormat delegate;
  final bool plainLineOnly;
  const _MarkdownAutoFormat(this.delegate, {this.plainLineOnly = false});

  @override
  AutoFormatResult? apply(
    ParchmentDocument document,
    int position,
    String data,
  ) {
    final style = document.collectStyle(position, 0);
    // Code is literal, and block shortcuts must not create nested block styles
    // that the visual Markdown model cannot represent.
    if (style.containsSame(ParchmentAttribute.code) ||
        style.containsSame(ParchmentAttribute.inlineCode) ||
        (plainLineOnly &&
            (style.contains(ParchmentAttribute.block) ||
                style.contains(ParchmentAttribute.heading)))) {
      return null;
    }
    return delegate.apply(document, position, data);
  }
}

// Keep keyboard shortcuts and toolbar formats within the Markdown model.
class _MarkdownController extends FleatherController {
  _MarkdownController({super.document, super.autoFormats});

  @override
  void formatText(
    int index,
    int length,
    ParchmentAttribute attribute, {
    bool notify = true,
  }) {
    if (attribute.key == ParchmentAttribute.underline.key) return;
    if (!attribute.isUnset) {
      if (attribute.key == ParchmentAttribute.heading.key) {
        super.formatText(
          index,
          length,
          ParchmentAttribute.block.unset,
          notify: false,
        );
        super.formatText(
          index,
          length,
          ParchmentAttribute.indent.unset,
          notify: false,
        );
      } else if (attribute.key == ParchmentAttribute.block.key) {
        super.formatText(
          index,
          length,
          ParchmentAttribute.heading.unset,
          notify: false,
        );
      } else if (attribute.key == ParchmentAttribute.indent.key) {
        final block = document
            .collectStyle(index, length)
            .value(ParchmentAttribute.block);
        if (!['ul', 'ol', 'cl'].contains(block)) return;
      }
    }
    super.formatText(index, length, attribute, notify: notify);
  }
}

class _CodeDialog extends StatefulWidget {
  final EmbeddableObject? initial;
  const _CodeDialog({this.initial});
  @override
  State<_CodeDialog> createState() => _CodeDialogState();
}

class _CodeDialogState extends State<_CodeDialog> {
  late final _code = TextEditingController(
    text: widget.initial?.data['code'] as String? ?? '',
  );
  late final _language = TextEditingController(
    text: widget.initial?.data['language'] as String? ?? '',
  );
  @override
  void dispose() {
    _code.dispose();
    _language.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SheetScaffold(
    title: 'Code block',
    body: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const FieldLabel('Language', hint: 'optional'),
        TextField(
          controller: _language,
          autocorrect: false,
          decoration: const InputDecoration(hintText: 'dart, typescript, sql…'),
        ),
        const SizedBox(height: 16),
        const FieldLabel('Code'),
        TextField(
          key: const Key('description-code'),
          controller: _code,
          autofocus: true,
          minLines: 6,
          maxLines: 12,
          autocorrect: false,
          enableSuggestions: false,
          keyboardType: TextInputType.multiline,
          style: const TextStyle(fontFamily: mono, fontSize: 13, height: 1.6),
          decoration: const InputDecoration(hintText: 'Paste or write code…'),
        ),
      ],
    ),
    actions: [
      AppButton(
        label: 'Cancel',
        tone: Tone.secondary,
        onPressed: () => Navigator.pop(context),
      ),
      AppButton(
        label: 'Apply',
        onPressed: () => Navigator.pop(
          context,
          MarkdownDocument.codeBlock(
            _code.text,
            _language.text.trim().split(RegExp(r'\s')).first,
          ),
        ),
      ),
    ],
  );
}

bool _safeUrl(String value, {bool image = false}) {
  final uri = Uri.tryParse(value);
  return uri != null &&
      !value.contains(RegExp(r'[\r\n<>]')) &&
      ((uri.scheme.isEmpty &&
              (value.startsWith('/') || value.startsWith('#'))) ||
          (['http', 'https'].contains(uri.scheme) && uri.host.isNotEmpty) ||
          (!image && uri.scheme == 'mailto' && uri.path.isNotEmpty));
}

void _launch(String? value) {
  if (value == null || !_safeUrl(value)) return;
  final uri = Uri.parse(value);
  if (uri.hasScheme) launchUrl(uri, mode: LaunchMode.externalApplication);
}

Future<String?> _showTextDialog(
  BuildContext context, {
  required String title,
  required String label,
  required String value,
  String? hint,
  bool multiline = false,
  String? Function(String)? validate,
}) => showAppSheet<String>(
  context,
  dismissible: false,
  maxWidth: 600,
  builder: (_) => _TextDialog(
    title: title,
    label: label,
    value: value,
    hint: hint,
    multiline: multiline,
    validate: validate,
  ),
);

class _TextDialog extends StatefulWidget {
  final String title, label, value;
  final String? hint;
  final bool multiline;
  final String? Function(String)? validate;
  const _TextDialog({
    required this.title,
    required this.label,
    required this.value,
    this.hint,
    this.multiline = false,
    this.validate,
  });
  @override
  State<_TextDialog> createState() => _TextDialogState();
}

class _TextDialogState extends State<_TextDialog> {
  late final _controller = TextEditingController(text: widget.value);
  final _form = GlobalKey<FormState>();
  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SheetScaffold(
    title: widget.title,
    body: Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FieldLabel(widget.label),
          TextFormField(
            controller: _controller,
            autofocus: true,
            minLines: widget.multiline ? 6 : 1,
            maxLines: widget.multiline ? 12 : 1,
            keyboardType: widget.multiline
                ? TextInputType.multiline
                : TextInputType.url,
            autocorrect: false,
            style: widget.multiline
                ? const TextStyle(fontFamily: mono, fontSize: 13)
                : null,
            decoration: InputDecoration(hintText: widget.hint),
            validator: (text) => widget.validate?.call(text?.trim() ?? ''),
          ),
        ],
      ),
    ),
    actions: [
      AppButton(
        label: 'Cancel',
        tone: Tone.secondary,
        onPressed: () => Navigator.pop(context),
      ),
      AppButton(
        label: 'Apply',
        onPressed: () {
          if (_form.currentState!.validate()) {
            Navigator.pop(
              context,
              widget.multiline ? _controller.text : _controller.text.trim(),
            );
          }
        },
      ),
    ],
  );
}

FleatherThemeData _editorTheme(BuildContext context) {
  const base = TextStyle(
    fontFamily: 'Geist',
    fontSize: 14.5,
    height: 1.55,
    color: Palette.fg,
  );
  TextBlockTheme block(TextStyle style, {BoxDecoration? decoration}) =>
      TextBlockTheme(
        style: style,
        spacing: const VerticalSpacing(top: 4, bottom: 8),
        lineSpacing: const VerticalSpacing(bottom: 3),
        decoration: decoration,
      );
  final fallback = FleatherThemeData.fallback(context);
  return FleatherThemeData(
    bold: const TextStyle(fontWeight: FontWeight.w600),
    italic: fallback.italic,
    underline: fallback.underline,
    strikethrough: fallback.strikethrough,
    inlineCode: InlineCodeThemeData(
      style: const TextStyle(
        fontFamily: mono,
        fontSize: 13,
        color: Color(0xffe3c7ff),
      ),
      backgroundColor: Palette.muted,
      radius: const Radius.circular(4),
    ),
    link: const TextStyle(
      color: Palette.primarySoft,
      decoration: TextDecoration.underline,
    ),
    paragraph: block(base),
    heading1: block(base.copyWith(fontSize: 21, fontWeight: FontWeight.w600)),
    heading2: block(base.copyWith(fontSize: 19, fontWeight: FontWeight.w600)),
    heading3: block(base.copyWith(fontSize: 17, fontWeight: FontWeight.w600)),
    heading4: block(base.copyWith(fontWeight: FontWeight.w600)),
    heading5: block(base.copyWith(fontWeight: FontWeight.w600)),
    heading6: block(base.copyWith(fontWeight: FontWeight.w600)),
    lists: block(base),
    quote: block(
      base.copyWith(color: Palette.fgMuted),
      decoration: const BoxDecoration(
        border: Border(left: BorderSide(color: Palette.borderStrong, width: 3)),
      ),
    ),
    code: block(
      base.copyWith(fontFamily: mono, fontSize: 13),
      decoration: BoxDecoration(
        color: Palette.sidebar,
        borderRadius: BorderRadius.circular(8),
      ),
    ),
    horizontalRule: HorizontalRuleThemeData(
      height: 16,
      thickness: 1,
      color: Palette.borderStrong,
    ),
  );
}
