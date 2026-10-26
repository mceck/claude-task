import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'theme.dart';

/// Fades and slides its child in once, after [delay]. No timers: the delay is
/// part of the animation, so nothing stays pending when it's disposed early.
class FadeSlideIn extends StatefulWidget {
  final Widget child;
  final Duration delay, duration;
  final Offset offset;
  final double scale;
  final bool enabled;
  const FadeSlideIn({
    super.key,
    required this.child,
    this.delay = Duration.zero,
    this.duration = Motion.medium,
    this.offset = const Offset(0, .08),
    this.scale = 1,
    this.enabled = true,
  });

  /// Staggers list items, capped so long lists don't wait.
  FadeSlideIn.staggered({
    Key? key,
    required int index,
    required Widget child,
    Offset offset = const Offset(0, .12),
    bool enabled = true,
  }) : this(
         key: key,
         enabled: enabled,
         delay: Duration(milliseconds: 30 * (index < 10 ? index : 10)),
         offset: offset,
         child: child,
       );

  @override
  State<FadeSlideIn> createState() => _FadeSlideInState();
}

final _introduced = <String>{};

/// True only the first time [key] asks in this app session: lists play their
/// entrance once, not every time you come back to them.
bool firstIntro(String key) => _introduced.add(key);

class _FadeSlideInState extends State<FadeSlideIn>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.delay + widget.duration,
  );
  late final Animation<double> _progress = CurvedAnimation(
    parent: _controller,
    curve: Interval(
      widget.delay.inMicroseconds /
          (widget.delay + widget.duration).inMicroseconds,
      1,
      curve: Motion.enter,
    ),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_controller.isAnimating || _controller.isCompleted) return;
    if (!widget.enabled || MediaQuery.disableAnimationsOf(context)) {
      _controller.value = 1;
    } else {
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _progress,
    child: widget.child,
    builder: (context, child) {
      final t = _progress.value;
      return Opacity(
        opacity: t.clamp(0, 1),
        child: FractionalTranslation(
          translation: widget.offset * (1 - t),
          child: widget.scale == 1
              ? child
              : Transform.scale(
                  scale: widget.scale + (1 - widget.scale) * t,
                  child: child,
                ),
        ),
      );
    },
  );
}

/// A rounded dashed outline, used for Internal chat and streaming text like
/// the web frontend's dashed borders.
class DashedOutline extends StatelessWidget {
  final Widget child;
  final Color color;
  final BorderRadius borderRadius;
  final double dash, gap, width;
  const DashedOutline({
    super.key,
    required this.child,
    required this.color,
    this.borderRadius = const BorderRadius.all(Radius.circular(Radii.md)),
    this.dash = 5,
    this.gap = 4,
    this.width = 1,
  });
  @override
  Widget build(BuildContext context) => CustomPaint(
    foregroundPainter: _DashedPainter(color, borderRadius, dash, gap, width),
    child: child,
  );
}

class _DashedPainter extends CustomPainter {
  final Color color;
  final BorderRadius radius;
  final double dash, gap, width;
  const _DashedPainter(
    this.color,
    this.radius,
    this.dash,
    this.gap,
    this.width,
  );
  @override
  void paint(Canvas canvas, Size size) {
    final rect = (Offset.zero & size).deflate(width / 2);
    final path = Path()..addRRect(radius.toRRect(rect));
    final paint = Paint()
      ..color = color
      ..strokeWidth = width
      ..style = PaintingStyle.stroke;
    for (final metric in path.computeMetrics()) {
      for (var d = 0.0; d < metric.length; d += dash + gap) {
        canvas.drawPath(metric.extractPath(d, d + dash), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_DashedPainter old) =>
      old.color != color || old.radius != radius || old.width != width;
}

/// Three bouncing dots while an Agent is writing.
class TypingDots extends StatefulWidget {
  final Color color;
  const TypingDots({super.key, this.color = Palette.violet});
  @override
  State<TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<TypingDots>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat();
  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < 3; i++)
          Builder(
            builder: (context) {
              final phase = ((_controller.value - i * .16) % 1 + 1) % 1;
              final lift = phase < .5
                  ? Curves.easeInOut.transform(phase * 2)
                  : 0.0;
              final up = phase < .25 ? lift : (phase < .5 ? 1 - lift : 0.0);
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1.5),
                child: Transform.translate(
                  offset: Offset(0, -3 * up),
                  child: Dot(
                    color: widget.color.withValues(alpha: .45 + .55 * up),
                    size: 5,
                  ),
                ),
              );
            },
          ),
      ],
    ),
  );
}

/// Tap target with hover and press feedback instead of Material ink.
class Pressable extends StatefulWidget {
  final Widget child;
  final VoidCallback? onTap, onLongPress;
  final Color color, hoverColor;
  final BorderRadius borderRadius;
  final EdgeInsetsGeometry? padding;
  final BoxBorder? border;
  final double pressedScale;
  final String? semanticLabel;
  const Pressable({
    super.key,
    required this.child,
    this.onTap,
    this.onLongPress,
    this.color = Colors.transparent,
    this.hoverColor = const Color(0x0dffffff),
    this.borderRadius = const BorderRadius.all(Radius.circular(Radii.md)),
    this.padding,
    this.border,
    this.pressedScale = .97,
    this.semanticLabel,
  });
  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _hover = false, _down = false;
  bool get _enabled => widget.onTap != null || widget.onLongPress != null;
  @override
  Widget build(BuildContext context) {
    final active = _enabled && (_hover || _down);
    return Semantics(
      button: _enabled,
      enabled: _enabled,
      label: widget.semanticLabel,
      child: MouseRegion(
        cursor: _enabled ? SystemMouseCursors.click : MouseCursor.defer,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap == null
              ? null
              : () {
                  HapticFeedback.selectionClick();
                  widget.onTap!();
                },
          onLongPress: widget.onLongPress == null
              ? null
              : () {
                  HapticFeedback.mediumImpact();
                  widget.onLongPress!();
                },
          onTapDown: _enabled ? (_) => setState(() => _down = true) : null,
          onTapUp: _enabled ? (_) => setState(() => _down = false) : null,
          onTapCancel: _enabled ? () => setState(() => _down = false) : null,
          child: AnimatedScale(
            scale: _down ? widget.pressedScale : 1,
            duration: const Duration(milliseconds: 110),
            curve: Curves.easeOut,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 140),
              padding: widget.padding,
              decoration: BoxDecoration(
                color: active
                    ? Color.alphaBlend(widget.hoverColor, widget.color)
                    : widget.color,
                borderRadius: widget.borderRadius,
                border: widget.border,
              ),
              child: widget.child,
            ),
          ),
        ),
      ),
    );
  }
}

enum Tone { primary, secondary, ghost, danger, warning, slate }

class AppButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final VoidCallback? onPressed;
  final Tone tone;
  final bool busy, expand, compact;
  const AppButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.tone = Tone.primary,
    this.busy = false,
    this.expand = false,
    this.compact = false,
  });
  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    final (background, foreground, border) = switch (tone) {
      Tone.primary => (Palette.primary, Colors.white, null),
      Tone.warning => (Palette.warning, const Color(0xff2a1d05), null),
      Tone.slate => (Palette.slateDeep, Colors.white, null),
      Tone.danger => (
        Palette.danger.withValues(alpha: .14),
        Palette.danger,
        Border.all(color: Palette.danger.withValues(alpha: .3)),
      ),
      Tone.secondary => (
        Palette.muted,
        Palette.fg,
        Border.all(color: Palette.border),
      ),
      Tone.ghost => (Colors.transparent, Palette.fgMuted, null),
    };
    final content = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (busy)
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Spinner(size: 14, color: foreground),
          )
        else if (icon != null)
          Padding(
            padding: const EdgeInsets.only(right: 7),
            child: Icon(icon, size: compact ? 16 : 18, color: foreground),
          ),
        Flexible(
          child: Text(
            label,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: foreground,
              fontWeight: FontWeight.w600,
              fontSize: compact ? 13 : 14.5,
              letterSpacing: -.1,
            ),
          ),
        ),
      ],
    );
    final solid =
        tone == Tone.primary || tone == Tone.warning || tone == Tone.slate;
    return AnimatedOpacity(
      opacity: enabled || busy ? 1 : .45,
      duration: Motion.fast,
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(compact ? 10 : Radii.md),
          boxShadow: tone == Tone.primary && enabled && !compact
              ? [
                  BoxShadow(
                    color: Palette.primary.withValues(alpha: .28),
                    blurRadius: 18,
                    offset: const Offset(0, 6),
                  ),
                ]
              : null,
        ),
        child: Pressable(
          onTap: enabled ? onPressed : null,
          color: background,
          hoverColor: solid ? const Color(0x1fffffff) : const Color(0x0fffffff),
          border: border,
          borderRadius: BorderRadius.circular(compact ? 10 : Radii.md),
          padding: EdgeInsets.symmetric(
            horizontal: compact ? 12 : 18,
            vertical: compact ? 8 : 13,
          ),
          child: content,
        ),
      ),
    );
  }
}

class IconAction extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final bool active, filled, badge;
  final Color? color;
  final double size;
  const IconAction({
    super.key,
    required this.icon,
    required this.tooltip,
    this.onPressed,
    this.active = false,
    this.filled = false,
    this.badge = false,
    this.color,
    this.size = 38,
  });
  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null;
    final foreground = filled
        ? Colors.white
        : active
        ? Palette.primarySoft
        : color ?? Palette.fgMuted;
    return Tooltip(
      message: tooltip,
      child: AnimatedOpacity(
        opacity: enabled ? 1 : .4,
        duration: const Duration(milliseconds: 150),
        child: Pressable(
          onTap: onPressed,
          semanticLabel: tooltip,
          pressedScale: .9,
          color: filled
              ? Palette.primary
              : active
              ? Palette.primary.withValues(alpha: .14)
              : Colors.transparent,
          hoverColor: filled
              ? const Color(0x1fffffff)
              : const Color(0x12ffffff),
          borderRadius: BorderRadius.circular(size / 3.2),
          child: SizedBox.square(
            dimension: size,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Icon(icon, size: size * .5, color: foreground),
                if (badge)
                  Positioned(
                    top: size * .2,
                    right: size * .2,
                    child: const Dot(color: Palette.primary, size: 7),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class Dot extends StatelessWidget {
  final Color color;
  final double size;
  final bool glow;
  const Dot({super.key, required this.color, this.size = 8, this.glow = false});
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      boxShadow: glow
          ? [BoxShadow(color: color.withValues(alpha: .6), blurRadius: 8)]
          : null,
    ),
  );
}

/// A dot that breathes while something is in progress.
class PulseDot extends StatefulWidget {
  final Color color;
  final double size;
  const PulseDot({super.key, required this.color, this.size = 8});
  @override
  State<PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<PulseDot>
    with SingleTickerProviderStateMixin {
  late final _anim = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat(reverse: true);
  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
    opacity: Tween(begin: .35, end: 1.0).animate(_anim),
    child: Dot(color: widget.color, size: widget.size, glow: true),
  );
}

class Spinner extends StatelessWidget {
  final double size;
  final Color color;
  const Spinner({super.key, this.size = 18, this.color = Palette.primary});
  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: size,
    child: CircularProgressIndicator(
      strokeWidth: size < 16 ? 1.8 : 2.2,
      color: color,
      strokeCap: StrokeCap.round,
    ),
  );
}

/// Rounded-square monogram for Projects and people.
class Avatar extends StatelessWidget {
  final String label;
  final String? emoji, seed;
  final double size;
  final bool circle, selected, initials;
  const Avatar({
    super.key,
    required this.label,
    this.emoji,
    this.seed,
    this.size = 36,
    this.circle = true,
    this.selected = false,
    this.initials = true,
  });
  @override
  Widget build(BuildContext context) {
    final base = tint(seed ?? label);
    final letters = label.trim().isEmpty
        ? '?'
        : emoji != null
        ? emoji!
        : !initials
        ? label
        : label
              .trim()
              .split(RegExp(r'\s+'))
              .take(2)
              .map((w) => w.characters.first.toUpperCase())
              .join();
    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: circle ? null : BorderRadius.circular(size * .3),
        shape: circle ? BoxShape.circle : BoxShape.rectangle,
        gradient: emoji != null
            ? null
            : LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  base.withValues(alpha: selected ? 1 : .32),
                  Color.lerp(
                    base,
                    Palette.bg,
                    .35,
                  )!.withValues(alpha: selected ? 1 : .22),
                ],
              ),
        color: emoji != null ? Palette.muted : null,
        border: Border.all(
          color: selected ? Colors.white24 : Palette.border,
          width: 1,
        ),
      ),
      child: Text(
        letters,
        maxLines: 1,
        style: TextStyle(
          fontSize: emoji != null
              ? size * .5
              : size * (letters.length > 2 ? .26 : .36),
          fontWeight: FontWeight.w600,
          color: selected ? Colors.white : Color.lerp(base, Colors.white, .45),
          letterSpacing: -.2,
          height: 1,
        ),
      ),
    );
  }
}

class Pill extends StatelessWidget {
  final String label;
  final Color color;
  final IconData? icon;
  final Widget? leading;
  final bool mono;
  const Pill({
    super.key,
    required this.label,
    this.color = Palette.fgMuted,
    this.icon,
    this.leading,
    this.mono = false,
  });
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .12),
      borderRadius: BorderRadius.circular(999),
      border: Border.all(color: color.withValues(alpha: .22)),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (leading != null) ...[leading!, const SizedBox(width: 5)],
        if (icon != null) ...[
          Icon(icon, size: 12, color: color),
          const SizedBox(width: 4),
        ],
        Flexible(
          child: Text(
            label,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w500,
              color: Color.lerp(color, Colors.white, .25),
              fontFamily: mono ? 'GeistMono' : null,
              height: 1.3,
            ),
          ),
        ),
      ],
    ),
  );
}

/// Toggleable pill used for filters and multi-selection.
class ChoiceChipX extends StatelessWidget {
  final String label;
  final bool selected;
  final ValueChanged<bool>? onChanged;
  final IconData? icon;
  final Widget? leading;
  final int? count;
  const ChoiceChipX({
    super.key,
    required this.label,
    required this.selected,
    this.onChanged,
    this.icon,
    this.leading,
    this.count,
  });
  @override
  Widget build(BuildContext context) => Pressable(
    onTap: onChanged == null ? null : () => onChanged!(!selected),
    color: selected ? Palette.primary.withValues(alpha: .16) : Palette.surface,
    border: Border.all(
      color: selected ? Palette.primary.withValues(alpha: .55) : Palette.border,
    ),
    borderRadius: BorderRadius.circular(999),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (leading != null) ...[leading!, const SizedBox(width: 6)],
        if (icon != null) ...[
          Icon(
            icon,
            size: 15,
            color: selected ? Palette.primarySoft : Palette.fgMuted,
          ),
          const SizedBox(width: 6),
        ],
        Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
            color: selected ? Palette.fg : Palette.fgMuted,
          ),
        ),
        if (count != null && count! > 0) ...[
          const SizedBox(width: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(
              color: Palette.primary,
              borderRadius: BorderRadius.circular(99),
            ),
            child: Text(
              '$count',
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: Colors.white,
              ),
            ),
          ),
        ],
      ],
    ),
  );
}

class Segment<T> {
  final T value;
  final String label;
  final IconData? icon;
  final Color? color;
  const Segment(this.value, this.label, {this.icon, this.color});
}

/// Segmented control with a sliding thumb.
class Segmented<T> extends StatelessWidget {
  final List<Segment<T>> segments;
  final T value;
  final ValueChanged<T>? onChanged;
  const Segmented({
    super.key,
    required this.segments,
    required this.value,
    this.onChanged,
  });
  @override
  Widget build(BuildContext context) {
    final index = segments.indexWhere((s) => s.value == value);
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: Palette.bg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Palette.border),
      ),
      child: IntrinsicWidth(
        child: Stack(
          children: [
            Positioned.fill(
              child: AnimatedAlign(
                duration: const Duration(milliseconds: 220),
                curve: Curves.easeOutCubic,
                alignment: Alignment(
                  segments.length == 1
                      ? 0
                      : -1 + 2 * index / (segments.length - 1),
                  0,
                ),
                child: FractionallySizedBox(
                  widthFactor: 1 / segments.length,
                  heightFactor: 1,
                  child: Container(
                    decoration: BoxDecoration(
                      color: (segments[index].color ?? Palette.primary)
                          .withValues(alpha: .18),
                      borderRadius: BorderRadius.circular(7),
                      border: Border.all(
                        color: (segments[index].color ?? Palette.primary)
                            .withValues(alpha: .4),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            Row(
              children: [
                for (final s in segments)
                  Expanded(
                    child: GestureDetector(
                      key: ValueKey('segment:${s.value}'),
                      behavior: HitTestBehavior.opaque,
                      onTap: onChanged == null || s.value == value
                          ? null
                          : () {
                              HapticFeedback.selectionClick();
                              onChanged!(s.value);
                            },
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 5,
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (s.icon != null) ...[
                              Icon(
                                s.icon,
                                size: 13,
                                color: s.value == value
                                    ? s.color ?? Palette.primarySoft
                                    : Palette.fgSubtle,
                              ),
                              const SizedBox(width: 5),
                            ],
                            Flexible(
                              child: Text(
                                s.label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                  color: s.value == value
                                      ? Palette.fg
                                      : Palette.fgSubtle,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class Notice extends StatelessWidget {
  final String message;
  final IconData icon;
  final Color color;
  final String? actionLabel;
  final VoidCallback? onAction, onClose;
  final Key? messageKey;
  const Notice({
    super.key,
    required this.message,
    this.icon = Icons.info_outline_rounded,
    this.color = Palette.warning,
    this.actionLabel,
    this.onAction,
    this.onClose,
    this.messageKey,
  });
  @override
  Widget build(BuildContext context) => Container(
    padding: EdgeInsets.fromLTRB(12, 8, onClose == null ? 8 : 4, 8),
    decoration: BoxDecoration(
      color: Color.alphaBlend(color.withValues(alpha: .1), Palette.surface),
      borderRadius: BorderRadius.circular(Radii.md),
      border: Border.all(color: color.withValues(alpha: .3)),
    ),
    child: Row(
      children: [
        Icon(icon, size: 17, color: color),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            message,
            key: messageKey,
            style: const TextStyle(fontSize: 13, height: 1.35),
          ),
        ),
        if (actionLabel != null) ...[
          const SizedBox(width: 8),
          Pressable(
            onTap: onAction,
            color: color.withValues(alpha: .16),
            borderRadius: BorderRadius.circular(8),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Text(
              actionLabel!,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                color: onAction == null
                    ? Palette.fgSubtle
                    : Color.lerp(color, Colors.white, .3),
              ),
            ),
          ),
        ],
        if (onClose != null)
          IconAction(
            icon: Icons.close_rounded,
            tooltip: 'Dismiss',
            onPressed: onClose,
            size: 30,
          ),
      ],
    ),
  );
}

class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.action,
  });
  @override
  Widget build(BuildContext context) => Center(
    child: SingleChildScrollView(
      padding: const EdgeInsets.all(32),
      child: FadeSlideIn(
        offset: const Offset(0, .06),
        duration: Motion.slow,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            FadeSlideIn(
              scale: .6,
              offset: Offset.zero,
              delay: const Duration(milliseconds: 80),
              duration: Motion.slow,
              child: Container(
                width: 68,
                height: 68,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(22),
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [
                      Palette.primary.withValues(alpha: .22),
                      Palette.primary.withValues(alpha: .04),
                    ],
                  ),
                  border: Border.all(
                    color: Palette.primary.withValues(alpha: .28),
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Palette.primary.withValues(alpha: .12),
                      blurRadius: 30,
                      offset: const Offset(0, 10),
                    ),
                  ],
                ),
                child: Icon(icon, color: Palette.primarySoft, size: 28),
              ),
            ),
            const SizedBox(height: 18),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            if (message != null) ...[
              const SizedBox(height: 6),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 300),
                child: Text(
                  message!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: Palette.fgMuted,
                    fontSize: 13.5,
                  ),
                ),
              ),
            ],
            if (action != null) ...[const SizedBox(height: 18), action!],
          ],
        ),
      ),
    ),
  );
}

class FieldLabel extends StatelessWidget {
  final String text;
  final String? hint;
  const FieldLabel(this.text, {super.key, this.hint});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 7, left: 2),
    child: Row(
      children: [
        Text(
          text,
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w500,
            color: Palette.fgMuted,
          ),
        ),
        if (hint != null) ...[
          const SizedBox(width: 6),
          Text(
            hint!,
            style: const TextStyle(fontSize: 12, color: Palette.fgSubtle),
          ),
        ],
      ],
    ),
  );
}

class SectionLabel extends StatelessWidget {
  final String text;
  final Widget? trailing;
  const SectionLabel(this.text, {super.key, this.trailing});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Row(
      children: [
        Expanded(
          child: Text(
            text.toUpperCase(),
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
  );
}

/// The app's mark: the web logo's three board columns on the accent gradient.
class BrandMark extends StatelessWidget {
  final double size;
  const BrandMark({super.key, this.size = 44});
  @override
  Widget build(BuildContext context) {
    // Same proportions as frontend/src/components/Logo.tsx (a 16-unit box).
    final unit = size * .58 / 16;
    Widget column(double height) => Container(
      width: 3 * unit,
      height: height * unit,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(unit),
      ),
    );
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * .3),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xfff0916b), Palette.primaryDeep],
        ),
        border: Border.all(color: Colors.white.withValues(alpha: .14)),
        boxShadow: [
          BoxShadow(
            color: Palette.primary.withValues(alpha: .35),
            blurRadius: size * .5,
            offset: Offset(0, size * .12),
          ),
        ],
      ),
      child: SizedBox.square(
        dimension: 16 * unit,
        child: Padding(
          padding: EdgeInsets.fromLTRB(2 * unit, 3 * unit, 2 * unit, 0),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [column(10), column(6), column(8)],
          ),
        ),
      ),
    );
  }
}

bool isCompact(BuildContext context) => MediaQuery.sizeOf(context).width < 700;

/// A bottom sheet on phones, a centered panel on wide windows.
Future<T?> showAppSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
  bool dismissible = true,
  double maxWidth = 520,
}) {
  if (isCompact(context)) {
    return showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      isDismissible: dismissible,
      enableDrag: dismissible,
      builder: (context) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: builder(context),
      ),
    );
  }
  return showGeneralDialog<T>(
    context: context,
    barrierDismissible: dismissible,
    barrierLabel: 'Dismiss',
    barrierColor: const Color(0xaa000000),
    transitionDuration: const Duration(milliseconds: 200),
    pageBuilder: (context, _, _) => Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: maxWidth,
            maxHeight: MediaQuery.sizeOf(context).height * .86,
          ),
          child: Material(
            color: Palette.raised,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(Radii.xl),
              side: const BorderSide(color: Palette.borderStrong),
            ),
            clipBehavior: Clip.antiAlias,
            child: builder(context),
          ),
        ),
      ),
    ),
    transitionBuilder: (context, animation, _, child) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
      );
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          scale: Tween(begin: .96, end: 1.0).animate(curved),
          child: child,
        ),
      );
    },
  );
}

/// Consistent sheet layout: grabber, title, scrollable body, footer.
class SheetScaffold extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget body;
  final List<Widget> actions;
  final bool scroll;
  const SheetScaffold({
    super.key,
    required this.title,
    required this.body,
    this.subtitle,
    this.actions = const [],
    this.scroll = true,
  });
  @override
  Widget build(BuildContext context) {
    final compact = isCompact(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (compact)
          Center(
            child: Container(
              margin: const EdgeInsets.only(top: 10),
              width: 38,
              height: 4,
              decoration: BoxDecoration(
                color: Palette.borderStrong,
                borderRadius: BorderRadius.circular(4),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(22, 16, 12, 4),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: Theme.of(context).textTheme.titleLarge),
                    if (subtitle != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                          subtitle!,
                          style: const TextStyle(
                            color: Palette.fgMuted,
                            fontSize: 13,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              IconAction(
                icon: Icons.close_rounded,
                tooltip: 'Close',
                size: 34,
                onPressed: () => Navigator.maybePop(context),
              ),
            ],
          ),
        ),
        Flexible(
          child: scroll
              ? SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(22, 12, 22, 8),
                  child: body,
                )
              : body,
        ),
        if (actions.isNotEmpty)
          Padding(
            padding: EdgeInsets.fromLTRB(22, 12, 22, compact ? 22 : 20),
            child: Row(
              children: [
                for (var i = 0; i < actions.length; i++) ...[
                  if (i > 0) const SizedBox(width: 10),
                  Expanded(child: actions[i]),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class ActionItem<T> {
  final T value;
  final String label;
  final IconData icon;
  final bool enabled, destructive;
  const ActionItem(
    this.value,
    this.label,
    this.icon, {
    this.enabled = true,
    this.destructive = false,
  });
}

/// Opens a list of actions anchored to [anchor] on wide windows and as an
/// action sheet on phones. Returns the chosen value.
Future<T?> showActions<T>(
  BuildContext anchor,
  List<ActionItem<T>> items, {
  String? title,
}) async {
  if (!isCompact(anchor)) {
    final box = anchor.findRenderObject() as RenderBox;
    final overlay =
        Navigator.of(anchor).overlay!.context.findRenderObject() as RenderBox;
    final origin = box.localToGlobal(Offset.zero, ancestor: overlay);
    return showMenu<T>(
      context: anchor,
      position: RelativeRect.fromLTRB(
        origin.dx,
        origin.dy + box.size.height + 6,
        overlay.size.width - origin.dx - box.size.width,
        0,
      ),
      menuPadding: const EdgeInsets.all(6),
      items: [
        for (final item in items)
          PopupMenuItem<T>(
            value: item.value,
            enabled: item.enabled,
            height: 40,
            padding: EdgeInsets.zero,
            child: _ActionRow(item: item, dense: true),
          ),
      ],
    );
  }
  return showModalBottomSheet<T>(
    context: anchor,
    useSafeArea: true,
    builder: (context) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(
                  color: Palette.borderStrong,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
            ),
            if (title != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 16, 12, 6),
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Palette.fgMuted,
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              )
            else
              const SizedBox(height: 10),
            for (final item in items)
              Pressable(
                onTap: item.enabled
                    ? () => Navigator.pop(context, item.value)
                    : null,
                pressedScale: .99,
                child: _ActionRow(item: item),
              ),
          ],
        ),
      ),
    ),
  );
}

class _ActionRow extends StatelessWidget {
  final ActionItem item;
  final bool dense;
  const _ActionRow({required this.item, this.dense = false});
  @override
  Widget build(BuildContext context) {
    final color = !item.enabled
        ? Palette.fgSubtle.withValues(alpha: .6)
        : item.destructive
        ? Palette.danger
        : Palette.fg;
    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: dense ? 12 : 14,
        vertical: dense ? 0 : 14,
      ),
      child: Row(
        children: [
          Icon(
            item.icon,
            size: dense ? 17 : 20,
            color: item.destructive && item.enabled
                ? Palette.danger
                : item.enabled
                ? Palette.fgMuted
                : color,
          ),
          SizedBox(width: dense ? 10 : 14),
          Text(
            item.label,
            style: TextStyle(
              color: color,
              fontSize: dense ? 13.5 : 15,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

class PickerOption<T> {
  final T value;
  final String label;
  final String? detail;
  final Widget? leading;
  const PickerOption(this.value, this.label, {this.detail, this.leading});
}

Future<T?> showPicker<T>(
  BuildContext context, {
  required String title,
  required List<PickerOption<T>> options,
  required T selected,
}) => showAppSheet<T>(
  context,
  maxWidth: 420,
  builder: (context) => SheetScaffold(
    title: title,
    body: Column(
      children: [
        for (final o in options)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Pressable(
              onTap: () => Navigator.pop(context, o.value),
              pressedScale: .99,
              color: o.value == selected
                  ? Palette.primary.withValues(alpha: .12)
                  : Colors.transparent,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
              child: Row(
                children: [
                  if (o.leading != null) ...[
                    o.leading!,
                    const SizedBox(width: 12),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          o.label,
                          style: const TextStyle(
                            fontSize: 14.5,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        if (o.detail != null)
                          Text(
                            o.detail!,
                            style: const TextStyle(
                              fontSize: 12.5,
                              color: Palette.fgMuted,
                            ),
                          ),
                      ],
                    ),
                  ),
                  if (o.value == selected)
                    const Icon(
                      Icons.check_rounded,
                      size: 18,
                      color: Palette.primarySoft,
                    ),
                ],
              ),
            ),
          ),
      ],
    ),
  ),
);

Future<bool> confirm(
  BuildContext context, {
  required String title,
  String? message,
  required String confirmLabel,
  bool destructive = true,
}) async {
  final accepted = await showGeneralDialog<bool>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Dismiss',
    barrierColor: const Color(0xaa000000),
    transitionDuration: const Duration(milliseconds: 180),
    pageBuilder: (dialog, _, _) => Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 380),
          child: Material(
            color: Palette.raised,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(Radii.xl),
              side: const BorderSide(color: Palette.borderStrong),
            ),
            child: Padding(
              padding: const EdgeInsets.all(22),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: (destructive ? Palette.danger : Palette.primary)
                          .withValues(alpha: .14),
                    ),
                    child: Icon(
                      destructive
                          ? Icons.delete_outline_rounded
                          : Icons.help_outline_rounded,
                      color: destructive ? Palette.danger : Palette.primarySoft,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(title, style: Theme.of(dialog).textTheme.titleLarge),
                  if (message != null) ...[
                    const SizedBox(height: 6),
                    Text(
                      message,
                      style: const TextStyle(
                        color: Palette.fgMuted,
                        fontSize: 14,
                      ),
                    ),
                  ],
                  const SizedBox(height: 22),
                  Row(
                    children: [
                      Expanded(
                        child: AppButton(
                          label: 'Cancel',
                          tone: Tone.secondary,
                          onPressed: () => Navigator.pop(dialog, false),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: AppButton(
                          label: confirmLabel,
                          tone: destructive ? Tone.danger : Tone.primary,
                          onPressed: () => Navigator.pop(dialog, true),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
    transitionBuilder: (context, animation, _, child) => FadeTransition(
      opacity: animation,
      child: ScaleTransition(
        scale: Tween(begin: .95, end: 1.0).animate(
          CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
        ),
        child: child,
      ),
    ),
  );
  return accepted == true;
}

void toast(BuildContext context, String message, {bool error = true}) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  messenger?.hideCurrentSnackBar();
  messenger?.showSnackBar(
    SnackBar(
      content: Row(
        children: [
          Icon(
            error ? Icons.error_outline_rounded : Icons.check_circle_rounded,
            size: 18,
            color: error ? Palette.danger : Palette.success,
          ),
          const SizedBox(width: 10),
          Expanded(child: Text(message)),
        ],
      ),
    ),
  );
}
