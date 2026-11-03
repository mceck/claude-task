import 'package:flutter_test/flutter_test.dart';
import 'package:claude_task_mobile/src/shell_command.dart';

List<String> _lines(String c) => [
  for (final s in splitShellCommand(c)) '${s.op}|${s.text}',
];

void main() {
  test('splits chains and pipes at the top level', () {
    expect(_lines('cd a && make | grep x || echo "no"; ls'), [
      '|cd a',
      '&&|make',
      '||grep x',
      '|||echo "no"',
      ';|ls',
    ]);
  });
  test('keeps quotes, subshells and heredocs whole', () {
    expect(_lines('echo "a && b" \$(x | y) && git commit -m "m"'), [
      '|echo "a && b" \$(x | y)',
      '&&|git commit -m "m"',
    ]);
    expect(_lines('cat <<EOF\na && b\nEOF'), ['|cat <<EOF\na && b\nEOF']);
  });
}
