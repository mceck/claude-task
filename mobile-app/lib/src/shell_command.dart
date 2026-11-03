/// One step of a shell command, with the operator that joins it to the previous one.
class ShellSegment {
  final String op;
  final String text;
  const ShellSegment(this.op, this.text);
}

/// Splits a shell command at its top-level `&&`, `||`, `|`, `;` and newlines, so
/// a long chain reads one step per line. Quotes, escapes and brackets are
/// respected; after a heredoc the rest is kept whole.
List<ShellSegment> splitShellCommand(String command) {
  final segments = <ShellSegment>[];
  var op = '';
  final cur = StringBuffer();
  String? quote;
  var depth = 0;
  void push(String next) {
    final text = cur.toString().trim();
    if (text.isNotEmpty) {
      segments.add(ShellSegment(op, text));
      op = next;
    }
    cur.clear();
  }

  for (var i = 0; i < command.length; i++) {
    final c = command[i];
    final two = command.substring(
      i,
      i + 2 > command.length ? command.length : i + 2,
    );
    if (c == r'\' && quote != "'") {
      cur.write(c);
      if (i + 1 < command.length) cur.write(command[i + 1]);
      i++;
      continue;
    }
    if (quote != null) {
      if (c == quote) quote = null;
      cur.write(c);
      continue;
    }
    if (c == "'" || c == '"' || c == '`') {
      quote = c;
      cur.write(c);
      continue;
    }
    if (c == '(' || c == '{' || c == '[') {
      depth++;
    } else if ((c == ')' || c == '}' || c == ']') && depth > 0) {
      depth--;
    }
    if (two == '<<' && (i + 2 >= command.length || command[i + 2] != '<')) {
      cur.write(command.substring(i));
      break;
    }
    if (depth == 0) {
      if (two == '&&' || two == '||') {
        push(two);
        i++;
        continue;
      }
      // `>|` is a redirection, not a pipe.
      if (c == '|' && !(i > 0 && command[i - 1] == '>')) {
        push('|');
        continue;
      }
      if (c == ';' || c == '\n') {
        push(';');
        continue;
      }
    }
    cur.write(c);
  }
  push('');
  return segments;
}
