import 'package:material_ui/material_ui.dart';

import '../models.dart';
import 'theme.dart';
import 'widgets.dart';

/// Compact token counts: `120.2K`, `1.2M`, `940`.
String formatContextTokens(num n) {
  // Round first, so 119.96K reads 120K and not 120.0K.
  String one(double v) {
    final r = (v * 10).round() / 10;
    return r == r.roundToDouble() ? r.toStringAsFixed(0) : r.toStringAsFixed(1);
  }
  if (n >= 1000000) return '${one(n / 1000000)}M';
  // Just below a million would read "1000K".
  if (n >= 999950) return '1M';
  if (n >= 1000) return '${one(n / 1000)}K';
  return n.round().toString();
}

/// The `context` of a Session: tokens carried and the model's window.
class ContextInfo {
  final num tokens;
  final num? window;
  /// Rounded to a whole number and capped at 100; null when the CLI reported no window.
  final num? pct;
  const ContextInfo(this.tokens, this.window, this.pct);

  String get label =>
      pct == null ? formatContextTokens(tokens) : '${formatContextTokens(tokens)} ($pct%)';

  String get title => pct == null
      ? 'Context: ${formatContextTokens(tokens)} tokens'
      : 'Context: ${formatContextTokens(tokens)} of ${formatContextTokens(window!)} tokens ($pct%)';

  /// Neutral until it fills up, then the usual warning and error tones.
  Color get color => pct == null || pct! < 70
      ? Palette.fgSubtle
      : pct! < 90
      ? Palette.orange
      : Palette.danger;
}

/// Reads a Session's `context`; null when the Session has no measurement.
ContextInfo? contextInfo(Json? context) {
  final tokens = context?['tokens'] as num?;
  if (tokens == null) return null;
  final window = context?['window'] as num?;
  final pct = window != null && window > 0
      ? (tokens / window * 100).round().clamp(0, 100)
      : null;
  return ContextInfo(tokens, window, pct);
}

/// How full the conversation's context is, beside the Session badge: `120.2K (53%)`.
class ContextBadge extends StatelessWidget {
  final Json? context;
  const ContextBadge({super.key, this.context});
  @override
  Widget build(BuildContext widgetContext) {
    final info = contextInfo(context);
    if (info == null) return const SizedBox.shrink();
    final color = info.color;
    return Tooltip(
      message: info.title,
      child: Container(
        padding: const EdgeInsets.fromLTRB(6, 2, 8, 2),
        decoration: BoxDecoration(
          color: color.withValues(alpha: .1),
          borderRadius: BorderRadius.circular(99),
          border: Border.all(color: color.withValues(alpha: .22)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Dot(color: color, size: 6),
            const SizedBox(width: 5),
            Text(
              info.label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w500,
                color: Color.lerp(color, Colors.white, .2),
                height: 1.3,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The same figure as plain inline text, for a Task list row.
class ContextLabel extends StatelessWidget {
  final Json? context;
  const ContextLabel({super.key, this.context});
  @override
  Widget build(BuildContext widgetContext) {
    final info = contextInfo(context);
    if (info == null) return const SizedBox.shrink();
    return Tooltip(
      message: info.title,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Dot(color: info.color, size: 5),
          const SizedBox(width: 4),
          Text(
            info.label,
            style: TextStyle(fontSize: 10.5, color: info.color),
          ),
        ],
      ),
    );
  }
}
