import 'package:material_ui/material_ui.dart';

import 'theme.dart';
import 'widgets.dart';

/// Spacing shared by every screen, so pages line up with each other.
abstract final class Space {
  /// Horizontal inset of page content and headers.
  static const page = 16.0;

  /// Space after each section of a page.
  static const section = 28.0;

  /// Space after each field of a form.
  static const field = 16.0;

  /// Space between rows of a list.
  static const row = 8.0;
}

/// Back, with the platform's arrow.
class BackAction extends StatelessWidget {
  final VoidCallback? onPressed;
  const BackAction({super.key, this.onPressed});
  @override
  Widget build(BuildContext context) {
    final platform = Theme.of(context).platform;
    final apple =
        platform == TargetPlatform.iOS || platform == TargetPlatform.macOS;
    return IconAction(
      icon: apple ? Icons.arrow_back_ios_new_rounded : Icons.arrow_back_rounded,
      tooltip: 'Back',
      onPressed: onPressed ?? () => Navigator.maybePop(context),
    );
  }
}

/// The top bar of every screen and pane: back or a leading mark, a title
/// with one secondary line, then the actions. One height and one type scale.
class PageHeader extends StatelessWidget {
  final String title;
  final String? subtitle;

  /// A second line made of widgets (state chips), in place of [subtitle].
  final Widget? meta;
  final Widget? leading;
  final VoidCallback? onBack, onTitleTap;
  final List<Widget> actions;
  const PageHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.meta,
    this.leading,
    this.onBack,
    this.onTitleTap,
    this.actions = const [],
  });

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minHeight: 64),
    padding: EdgeInsets.fromLTRB(
      onBack != null
          ? 6
          : leading != null
          ? 10
          : Space.page,
      10,
      10,
      10,
    ),
    decoration: const BoxDecoration(
      border: Border(bottom: BorderSide(color: Palette.border)),
    ),
    child: Row(
      children: [
        if (onBack != null) ...[
          BackAction(onPressed: onBack),
          const SizedBox(width: 4),
        ],
        if (leading != null) ...[leading!, const SizedBox(width: 12)],
        Expanded(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onTitleTap,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 17,
                    height: 1.3,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -.3,
                  ),
                ),
                if (meta != null)
                  Padding(padding: const EdgeInsets.only(top: 3), child: meta)
                else if (subtitle != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 12,
                        color: Palette.fgSubtle,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        for (final action in actions) ...[const SizedBox(width: 2), action],
      ],
    ),
  );
}

/// A pushed full screen: header with Back, then a width-capped body.
class AppPage extends StatelessWidget {
  final String title;
  final String? subtitle;
  final List<Widget> actions;
  final Widget body;
  const AppPage({
    super.key,
    required this.title,
    required this.body,
    this.subtitle,
    this.actions = const [],
  });
  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Palette.bg,
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              PageHeader(
                title: title,
                subtitle: subtitle,
                onBack: () => Navigator.maybePop(context),
                actions: actions,
              ),
              Expanded(child: body),
            ],
          ),
        ),
      ),
    ),
  );
}

/// The scrolling body of a page, with the page insets.
class PageList extends StatelessWidget {
  final List<Widget> children;
  const PageList({super.key, required this.children});
  @override
  Widget build(BuildContext context) => ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    padding: const EdgeInsets.fromLTRB(Space.page, 16, Space.page, 32),
    children: children,
  );
}

/// Pull to refresh with the app's colors.
class AppRefresh extends StatelessWidget {
  final Future<void> Function() onRefresh;
  final Widget child;
  const AppRefresh({super.key, required this.onRefresh, required this.child});
  @override
  Widget build(BuildContext context) => RefreshIndicator(
    color: Palette.primary,
    backgroundColor: Palette.raised,
    onRefresh: onRefresh,
    child: child,
  );
}

/// A titled group of rows or fields. Sections are spaced evenly down a page.
class Section extends StatelessWidget {
  final String title;
  final String? description;
  final Widget? trailing;
  final List<Widget> children;
  const Section({
    super.key,
    required this.title,
    required this.children,
    this.description,
    this.trailing,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: Space.section),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 32,
          child: Row(
            children: [
              Expanded(
                child: Text(
                  title.toUpperCase(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    letterSpacing: .9,
                    color: Palette.fgSubtle,
                  ),
                ),
              ),
              ?trailing,
            ],
          ),
        ),
        if (description != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Text(
              description!,
              style: const TextStyle(
                fontSize: 12.5,
                height: 1.4,
                color: Palette.fgSubtle,
              ),
            ),
          )
        else
          const SizedBox(height: 4),
        ...children,
      ],
    ),
  );
}

/// The add button at the right of a [Section] title.
class SectionAdd extends StatelessWidget {
  final String tooltip;
  final VoidCallback? onPressed;
  const SectionAdd({super.key, required this.tooltip, this.onPressed});
  @override
  Widget build(BuildContext context) => IconAction(
    icon: Icons.add_rounded,
    tooltip: tooltip,
    size: 32,
    onPressed: onPressed,
  );
}

/// A tinted square behind an icon, used to lead rows.
class IconBadge extends StatelessWidget {
  final IconData icon;
  final Color color;
  final double size;
  const IconBadge(this.icon, {super.key, required this.color, this.size = 32});
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: color.withValues(alpha: .14),
      borderRadius: BorderRadius.circular(size * .3),
    ),
    child: Icon(icon, size: size * .55, color: color),
  );
}

/// The list row of the app: a card with leading, title, subtitle and
/// trailing. Tappable rows without a trailing widget show a chevron.
class AppTile extends StatelessWidget {
  final Widget? leading, trailing;
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final bool selected, monospace;
  final int subtitleLines;
  const AppTile({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
    this.selected = false,
    this.monospace = false,
    this.subtitleLines = 2,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: Space.row),
    child: Pressable(
      onTap: onTap,
      semanticLabel: title,
      pressedScale: .99,
      color: selected
          ? Color.alphaBlend(
              Palette.primary.withValues(alpha: .1),
              Palette.surface,
            )
          : Palette.surface,
      border: Border.all(
        color: selected
            ? Palette.primary.withValues(alpha: .45)
            : Palette.border,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          if (leading != null) ...[leading!, const SizedBox(width: 12)],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14.5,
                    height: 1.35,
                    fontWeight: FontWeight.w600,
                    fontFamily: monospace ? mono : null,
                  ),
                ),
                if (subtitle != null && subtitle!.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      subtitle!,
                      maxLines: subtitleLines,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 12.5,
                        height: 1.35,
                        color: Palette.fgSubtle,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 8), trailing!],
          if (onTap != null && trailing == null)
            const Icon(
              Icons.chevron_right_rounded,
              color: Palette.fgSubtle,
              size: 20,
            ),
        ],
      ),
    ),
  );
}

/// Trailing mark of rows that open outside the app.
const externalMark = Icon(
  Icons.open_in_new_rounded,
  size: 16,
  color: Palette.fgSubtle,
);

/// What an empty section says in place of its rows.
class EmptyHint extends StatelessWidget {
  final String text;
  const EmptyHint(this.text, {super.key});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: Space.row),
    child: DashedOutline(
      color: Palette.borderStrong,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        child: Text(
          text,
          style: const TextStyle(fontSize: 13, color: Palette.fgSubtle),
        ),
      ),
    ),
  );
}

/// A form input with its label above and an optional explanation: the one
/// layout for fields in forms and settings.
class LabeledField extends StatelessWidget {
  final String label;

  /// A short qualifier beside the label, like "optional".
  final String? hint;

  /// A sentence under the label explaining the field.
  final String? description;
  final Widget child;
  const LabeledField({
    super.key,
    required this.label,
    required this.child,
    this.hint,
    this.description,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: Space.field),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FieldLabel(label, hint: hint),
        if (description != null)
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 8),
            child: Text(
              description!,
              style: const TextStyle(
                fontSize: 12,
                height: 1.4,
                color: Palette.fgSubtle,
              ),
            ),
          ),
        child,
      ],
    ),
  );
}

/// A field showing its current choice; tapping opens a picker.
class SelectField extends StatelessWidget {
  final Widget? leading;
  final String label;

  /// Shows [label] muted, as when nothing is chosen yet.
  final bool placeholder;
  final VoidCallback? onTap;
  const SelectField({
    super.key,
    required this.label,
    this.leading,
    this.placeholder = false,
    this.onTap,
  });
  @override
  Widget build(BuildContext context) => AnimatedOpacity(
    opacity: onTap == null ? .5 : 1,
    duration: Motion.fast,
    child: Pressable(
      onTap: onTap,
      semanticLabel: label,
      pressedScale: .99,
      color: Palette.surface,
      border: Border.all(color: Palette.border),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      child: Row(
        children: [
          if (leading != null) ...[leading!, const SizedBox(width: 12)],
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 14.5,
                height: 1.5,
                color: placeholder ? Palette.fgSubtle : Palette.fg,
              ),
            ),
          ),
          const Icon(
            Icons.unfold_more_rounded,
            size: 18,
            color: Palette.fgSubtle,
          ),
        ],
      ),
    ),
  );
}

/// A labelled switch; the whole row toggles it.
class SwitchRow extends StatelessWidget {
  final String label;
  final String? description;
  final bool value;
  final ValueChanged<bool>? onChanged;
  const SwitchRow({
    super.key,
    required this.label,
    required this.value,
    this.onChanged,
    this.description,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: Space.row),
    child: Pressable(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      pressedScale: 1,
      padding: const EdgeInsets.fromLTRB(2, 4, 0, 4),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: const TextStyle(fontSize: 14.5)),
                if (description != null)
                  Text(
                    description!,
                    style: const TextStyle(
                      fontSize: 12,
                      color: Palette.fgSubtle,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Switch(value: value, onChanged: onChanged),
        ],
      ),
    ),
  );
}

/// The failure of a whole screen's data, with Retry.
class LoadError extends StatelessWidget {
  final Object error;
  final VoidCallback onRetry;
  const LoadError({super.key, required this.error, required this.onRetry});
  @override
  Widget build(BuildContext context) => EmptyState(
    icon: Icons.cloud_off_rounded,
    title: 'Couldn’t load this page',
    message: error.toString(),
    action: AppButton(
      label: 'Retry',
      icon: Icons.refresh_rounded,
      tone: Tone.secondary,
      onPressed: onRetry,
    ),
  );
}
