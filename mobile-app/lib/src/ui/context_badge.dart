import 'package:material_ui/material_ui.dart';

import '../models.dart';
import 'theme.dart';
import 'widgets.dart';

/// Compact token counts: `120.2K`, `1.2M`, `940`.
String formatContextTokens(num n) {
  String one(double v) =>
      v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(1);
  if (n >= 1000000) return '${one(n / 1000000)}M';
  // Just below a million would read "1000K".
  if (n >= 999950) return '1M';
  if (n >= 1000) return '${one(n / 1000)}K';
  return n.round().toString();
}

/// How full the conversation's context is, beside the Session badge: `120.2K (53%)`.
class ContextBadge extends StatelessWidget {
  final Json? session;
  const ContextBadge({super.key, this.session});
  @override
  Widget build(BuildContext context) {
    final raw = session?['context'];
    final tokens = raw is Map ? raw['tokens'] as num? : null;
    if (tokens == null) return const SizedBox.shrink();
    final window = raw is Map ? raw['window'] as num? : null;
    final pct = window != null && window > 0
        ? (tokens / window * 100).round().clamp(0, 100)
        : null;
    // Neutral until it fills up, then the usual warning and error tones.
    final color = pct == null || pct < 70
        ? Palette.fgSubtle
        : pct < 90
        ? Palette.orange
        : Palette.danger;
    final detail = pct == null
        ? 'Context: ${formatContextTokens(tokens)} tokens'
        : 'Context: ${formatContextTokens(tokens)} of ${formatContextTokens(window!)} tokens ($pct%)';
    return Tooltip(
      message: detail,
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
              pct == null
                  ? formatContextTokens(tokens)
                  : '${formatContextTokens(tokens)} ($pct%)',
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
