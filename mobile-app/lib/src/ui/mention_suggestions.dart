import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../models.dart';
import 'theme.dart';
import 'user_avatar.dart';
import 'widgets.dart';

/// A word-boundary @ token, keeping email addresses as ordinary text.
({int start, String query})? mentionAtCaret(TextEditingValue value) {
  final caret = value.selection.baseOffset;
  if (caret < 0 || caret > value.text.length || !value.selection.isCollapsed) {
    return null;
  }
  final match = RegExp(r'(?:^|\s)@([^\s@\[\]()]*)$')
      .firstMatch(value.text.substring(0, caret));
  if (match == null) return null;
  return (
    start: caret - match.group(1)!.length - 1,
    query: match.group(1)!.toLowerCase(),
  );
}

class MentionSuggestions extends StatefulWidget {
  final TextEditingController text;
  final List<User> users;
  final ValueChanged<String> onSelected;
  const MentionSuggestions({
    super.key,
    required this.text,
    required this.users,
    required this.onSelected,
  });

  @override
  State<MentionSuggestions> createState() => MentionSuggestionsState();
}

class MentionSuggestionsState extends State<MentionSuggestions> {
  int _active = 0;
  TextEditingValue? _dismissed;
  final _scroll = ScrollController();

  List<User> get _people {
    final value = widget.text.value;
    final token = mentionAtCaret(value);
    if (token == null || value == _dismissed) return [];
    return widget.users
        .where(
          (u) =>
              u.active &&
              '${u.displayName} ${u.email}'.toLowerCase().contains(token.query),
        )
        .toList();
  }

  @override
  void initState() {
    super.initState();
    widget.text.addListener(_changed);
  }

  @override
  void didUpdateWidget(MentionSuggestions oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) {
      oldWidget.text.removeListener(_changed);
      widget.text.addListener(_changed);
    }
  }

  void _changed() => setState(() => _active = 0);

  @override
  void dispose() {
    widget.text.removeListener(_changed);
    _scroll.dispose();
    super.dispose();
  }

  void _choose(User user) {
    final value = widget.text.value, token = mentionAtCaret(widget.text.value);
    if (token == null) return;
    final caret = value.selection.baseOffset;
    final suffix =
        RegExp(r'^[^\s@\[\]()]*')
            .firstMatch(value.text.substring(caret))
            ?.end ??
        0;
    final label = user.displayName.replaceAllMapped(
      RegExp(r'[\\\[\]]'),
      (m) => '\\${m[0]}',
    );
    final insertion = '[@$label](/users/${user.id}) ';
    final next = value.text.replaceRange(
      token.start,
      caret + suffix,
      insertion,
    );
    widget.text.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(
        offset: token.start + insertion.length,
      ),
    );
    widget.onSelected(next);
  }

  /// The composer delegates these keys before its Enter-to-send handler.
  bool handleKey(KeyEvent event) {
    if (widget.text.value.composing.isValid &&
        !widget.text.value.composing.isCollapsed) {
      return false;
    }
    final people = _people;
    if (people.isEmpty || HardwareKeyboard.instance.isShiftPressed) {
      return false;
    }
    final key = event.logicalKey;
    if (![
      LogicalKeyboardKey.arrowDown,
      LogicalKeyboardKey.arrowUp,
      LogicalKeyboardKey.enter,
      LogicalKeyboardKey.numpadEnter,
      LogicalKeyboardKey.tab,
      LogicalKeyboardKey.escape,
    ].contains(key)) {
      return false;
    }
    if (event is! KeyDownEvent) return true;
    if (key == LogicalKeyboardKey.escape) {
      setState(() => _dismissed = widget.text.value);
    } else if (key == LogicalKeyboardKey.arrowDown ||
        key == LogicalKeyboardKey.arrowUp) {
      setState(
        () => _active =
            (_active +
                (key == LogicalKeyboardKey.arrowDown ? 1 : -1) +
                people.length) %
            people.length,
      );
      if (_scroll.hasClients) {
        _scroll.jumpTo(
          (_active * 56.0).clamp(0, _scroll.position.maxScrollExtent),
        );
      }
    } else {
      _choose(people[_active.clamp(0, people.length - 1)]);
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final people = _people;
    if (people.isEmpty) return const SizedBox.shrink();
    return Semantics(
      label: 'Mention people',
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        constraints: const BoxConstraints(maxHeight: 220),
        decoration: BoxDecoration(
          color: Palette.raised,
          borderRadius: BorderRadius.circular(Radii.md),
          border: Border.all(color: Palette.borderStrong),
          boxShadow: const [
            BoxShadow(
              color: Color(0x66000000),
              blurRadius: 24,
              offset: Offset(0, 8),
            ),
          ],
        ),
        child: ListView.builder(
          controller: _scroll,
          shrinkWrap: true,
          itemCount: people.length,
          itemExtent: 56,
          padding: const EdgeInsets.all(4),
          itemBuilder: (context, index) {
            final user = people[index];
            return Semantics(
              selected: index == _active,
              child: Pressable(
                key: ValueKey('mention-user:${user.id}'),
                borderRadius: BorderRadius.circular(Radii.sm),
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                onTap: () => _choose(user),
                child: Row(
                  children: [
                    UserAvatar(label: user.displayName, api: null, size: 28),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            '@${user.displayName}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              color: index == _active
                                  ? Palette.primarySoft
                                  : Palette.fg,
                            ),
                          ),
                          Text(
                            user.email,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              color: Palette.fgMuted,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
