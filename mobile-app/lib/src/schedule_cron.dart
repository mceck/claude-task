/// Five-field cron expressions, read the way the web app reads them
/// (shared/src/cron.ts). The backend validates and schedules; the clients only
/// need the readable cadence and, in the form, whether an expression parses.
library;

const _monthNames = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const _dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const _daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

class CronSpec {
  final Set<int> minutes, hours, daysOfMonth, months, daysOfWeek;
  final bool domRestricted, dowRestricted;
  const CronSpec({
    required this.minutes,
    required this.hours,
    required this.daysOfMonth,
    required this.months,
    required this.daysOfWeek,
    required this.domRestricted,
    required this.dowRestricted,
  });
}

int? _parseValue(String text, List<String>? names, int nameBase) {
  if (RegExp(r'^\d+$').hasMatch(text)) return int.tryParse(text);
  final index = names?.indexOf(text.toLowerCase()) ?? -1;
  return index >= 0 ? index + nameBase : null;
}

Set<int>? _parseField(
  String text,
  int min,
  int max,
  List<String>? names,
  int nameBase,
) {
  final values = <int>{};
  for (final part in text.split(',')) {
    final pieces = part.split('/');
    if (pieces.length > 2 || pieces[0].isEmpty) return null;
    final range = pieces[0], step = pieces.length == 2 ? pieces[1] : null;
    var stepSize = 1;
    if (step != null) {
      if (!RegExp(r'^\d+$').hasMatch(step) || int.parse(step) < 1) return null;
      stepSize = int.parse(step);
    }
    int? from, to;
    if (range == '*') {
      from = min;
      to = max;
    } else if (range.contains('-')) {
      final bounds = range.split('-');
      if (bounds.length > 2) return null;
      from = _parseValue(bounds[0], names, nameBase);
      to = _parseValue(bounds[1], names, nameBase);
    } else {
      from = _parseValue(range, names, nameBase);
      to = step != null ? max : from;
    }
    if (from == null || to == null || from < min || to > max || from > to) {
      return null;
    }
    for (var v = from; v <= to; v += stepSize) {
      values.add(v);
    }
  }
  return values;
}

/// The parsed expression, or null when it is malformed or can never run.
CronSpec? parseCron(String expression) {
  final fields = expression.trim().split(RegExp(r'\s+'));
  if (fields.length != 5 || fields.any((f) => f.isEmpty)) return null;
  final minutes = _parseField(fields[0], 0, 59, null, 0);
  final hours = _parseField(fields[1], 0, 23, null, 0);
  final daysOfMonth = _parseField(fields[2], 1, 31, null, 0);
  final months = _parseField(fields[3], 1, 12, _monthNames, 1);
  final rawDow = _parseField(fields[4], 0, 7, _dayNames, 0);
  if (minutes == null ||
      hours == null ||
      daysOfMonth == null ||
      months == null ||
      rawDow == null) {
    return null;
  }
  final domRestricted = !fields[2].startsWith('*');
  final dowRestricted = !fields[4].startsWith('*');
  if (domRestricted &&
      !dowRestricted &&
      !months.any((mo) => daysOfMonth.any((d) => d <= _daysInMonth[mo - 1]))) {
    return null;
  }
  return CronSpec(
    minutes: minutes,
    hours: hours,
    daysOfMonth: daysOfMonth,
    months: months,
    daysOfWeek: rawDow.map((d) => d % 7).toSet(),
    domRestricted: domRestricted,
    dowRestricted: dowRestricted,
  );
}

const _weekdays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

String _pad(int n) => n.toString().padLeft(2, '0');

/// A short reading of the common shapes of expression; anything else is shown
/// as the expression itself.
String describeCron(String expression) {
  final spec = parseCron(expression);
  final fields = expression.trim().split(RegExp(r'\s+'));
  if (spec == null || fields.length != 5) return expression;
  final minute = fields[0], hour = fields[1], dom = fields[2];
  final month = fields[3], dow = fields[4];
  final everyDay = dom == '*' && month == '*';
  final step = RegExp(r'^\*/(\d+)$').firstMatch(minute);
  if (step != null && hour == '*' && everyDay && dow == '*') {
    return 'Every ${step.group(1)} minutes';
  }
  if (minute == '*' && hour == '*' && everyDay && dow == '*') {
    return 'Every minute';
  }
  final single =
      RegExp(r'^\d+$').hasMatch(minute) && RegExp(r'^\d+$').hasMatch(hour);
  if (RegExp(r'^\d+$').hasMatch(minute) &&
      hour == '*' &&
      everyDay &&
      dow == '*') {
    return minute == '0' ? 'Every hour' : 'Every hour at minute $minute';
  }
  if (!single) return expression;
  final time = '${_pad(int.parse(hour))}:${_pad(int.parse(minute))}';
  if (everyDay && dow == '*') return 'Every day at $time';
  if (everyDay && !spec.domRestricted) {
    final days = spec.daysOfWeek.toList()..sort();
    if (days.join(',') == '1,2,3,4,5') return 'Monday to Friday at $time';
    return 'Every ${days.map((d) => _weekdays[d]).join(', ')} at $time';
  }
  if (month == '*' && dow == '*' && RegExp(r'^\d+$').hasMatch(dom)) {
    return 'Day $dom of every month at $time';
  }
  return expression;
}
