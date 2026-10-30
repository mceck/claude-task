/// Native counterpart of the shared dotenv parser, used for import previews.
class ProjectEnvPreview {
  final Map<String, String> entries;
  final List<String> errors;
  const ProjectEnvPreview(this.entries, this.errors);
  bool get valid => errors.isEmpty && entries.isNotEmpty;
}

final _envName = RegExp(r'^[A-Za-z_][A-Za-z0-9_]{0,127}$');
final _reservedEnv = RegExp(
  r'^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_RESUME_INTERRUPTED_TURN|CLAUDE_TASK_.*|HOME|PATH|USER)$',
);

String? validateProjectEnvName(String name) {
  if (!_envName.hasMatch(name)) {
    return 'Use a letter or underscore, then letters, digits or underscores (128 characters maximum).';
  }
  if (_reservedEnv.hasMatch(name)) return '$name is set by the platform.';
  return null;
}

ProjectEnvPreview previewProjectEnv(String content, {int maxVariables = 500}) {
  final entries = <String, String>{};
  final errors = <String>[];
  if (content.length > 500000) {
    return const ProjectEnvPreview({}, ['The .env file is too large.']);
  }
  final lines = content
      .replaceFirst(RegExp('^\uFEFF'), '')
      .split(RegExp(r'\r?\n'));
  for (var i = 0; i < lines.length; i++) {
    final lineNo = i + 1;
    final line = lines[i].trim();
    if (line.isEmpty || line.startsWith('#')) continue;
    final match = RegExp(r'^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$')
        .firstMatch(line);
    if (match == null) {
      errors.add('Line $lineNo: expected NAME=value');
      continue;
    }
    final name = match[1]!;
    final nameError = validateProjectEnvName(name);
    if (nameError != null) errors.add('Line $lineNo: $name: $nameError');
    var rest = match[2]!;
    final quote = rest.isEmpty ? '' : rest[0];
    String value;
    if (quote == '"' || quote == "'" || quote == '`') {
      var body = rest.substring(1);
      var end = _closingQuote(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        body += '\n${lines[++i]}';
        end = _closingQuote(body, quote);
      }
      if (end < 0) {
        errors.add('Line $lineNo: unterminated $quote quote');
        continue;
      }
      final trailing = body.substring(end + 1).trim();
      if (trailing.isNotEmpty && !trailing.startsWith('#')) {
        errors.add('Line $lineNo: unexpected text after the closing quote');
        continue;
      }
      value = body.substring(0, end);
      if (quote == '"') {
        value = value.replaceAllMapped(
          RegExp(r'\\(.)'),
          (m) => switch (m[1]) {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            '"' => '"',
            r'\' => r'\',
            _ => m[0]!,
          },
        );
      }
    } else {
      rest = rest.replaceFirst(RegExp(r'\s+#.*$'), '');
      value = rest.startsWith('#') ? '' : rest.trim();
    }
    entries[name] = value;
  }
  for (final entry in entries.entries) {
    if (entry.value.length > 100000) {
      errors.add('${entry.key} exceeds 100,000 characters.');
    }
  }
  if (entries.isEmpty && errors.isEmpty) errors.add('No variables found.');
  if (entries.length > maxVariables) {
    errors.add('Use at most $maxVariables variables at a time.');
  }
  return ProjectEnvPreview(entries, errors);
}

String _quoteAgentEnv(String value) {
  final escaped = value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '\\r')
      .replaceAll('\t', '\\t');
  return '"$escaped"';
}

/// Agent environment variables, in the same `NAME=value` syntax as a `.env` file.
String formatAgentEnv(Map<String, dynamic> env) {
  final entries = [
    for (final entry in env.entries)
      if (entry.value is String) entry.key,
  ]..sort();
  return [
    for (final name in entries) '$name=${_quoteAgentEnv(env[name] as String)}',
  ].join('\n');
}

/// Parses the Agent form's text field; throws a readable error for invalid or reserved names.
Map<String, String> parseAgentEnvText(String text) {
  if (text.trim().isEmpty) return {};
  final preview = previewProjectEnv(text, maxVariables: 100);
  if (preview.errors.isNotEmpty) {
    throw FormatException(preview.errors.join('\n'));
  }
  return preview.entries;
}

int _closingQuote(String body, String quote) {
  for (var i = 0; i < body.length; i++) {
    if (quote == '"' && body[i] == r'\') {
      i++;
    } else if (body[i] == quote) {
      return i;
    }
  }
  return -1;
}
