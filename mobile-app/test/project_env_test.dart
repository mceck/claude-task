import 'package:claude_task_mobile/src/project_env.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('dotenv preview follows shared quoting, comments, duplicates and literal references', () {
    final preview = previewProjectEnv('''
\uFEFF# configuration
export API_URL=https://api.example.com # comment
EMPTY= # comment
DOUBLE="line\\nnext\\t\\"quoted\\""
SINGLE='first
second'
BACKTICK=`literal # value`
REFERENCE=\${API_URL}
API_URL=https://last.example.com
''');
    expect(preview.errors, isEmpty);
    expect(preview.entries, {
      'API_URL': 'https://last.example.com',
      'EMPTY': '',
      'DOUBLE': 'line\nnext\t"quoted"',
      'SINGLE': 'first\nsecond',
      'BACKTICK': 'literal # value',
      'REFERENCE': r'${API_URL}',
    });
  });

  test('dotenv preview reports invalid lines and unclosed quotes with line numbers', () {
    final preview = previewProjectEnv('OK=1\nbroken\n1BAD=x\nQ="open');
    expect(preview.valid, isFalse);
    expect(preview.errors, hasLength(3));
    expect(preview.errors[0], 'Line 2: expected NAME=value');
    expect(preview.errors[1], startsWith('Line 3:'));
    expect(preview.errors[2], 'Line 4: unterminated " quote');
  });

  test('dotenv preview validates reserved names and import limits', () {
    for (final content in [
      '# no entries',
      'HOME=/tmp',
      'CLAUDE_TASK_TOKEN=secret',
      'VALUE=${'x' * 100001}',
      List.generate(501, (i) => 'KEY_$i=value').join('\n'),
      'CONTENT=${'x' * 500000}',
      'NAME="quoted" trailing',
    ]) {
      expect(previewProjectEnv(content).valid, isFalse);
    }
    expect(validateProjectEnvName('_VALID_123'), isNull);
    expect(validateProjectEnvName('A' * 128), isNull);
    expect(validateProjectEnvName('A' * 129), isNotNull);
    expect(previewProjectEnv('KEY=${'x' * 100001}\nKEY=short').valid, isTrue);
  });
}
