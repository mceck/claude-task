import 'package:claude_task_mobile/src/schedule_cron.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('parseCron', () {
    test('accepts the common shapes', () {
      for (final expression in [
        '* * * * *',
        '*/15 * * * *',
        '0 9 * * 1-5',
        '0 8,12,18 * * mon-fri',
        '0 0 1 jan,jul *',
        '0 0 * * 7',
      ]) {
        expect(parseCron(expression), isNotNull, reason: expression);
      }
    });

    test('rejects malformed and impossible expressions', () {
      for (final expression in [
        '',
        '* * * *',
        '* * * * * *',
        '60 * * * *',
        '0 24 * * *',
        '0 9 31 2 *',
        '0 9 * * 8',
        '*/0 * * * *',
        '1-2-3 * * * *',
      ]) {
        expect(parseCron(expression), isNull, reason: expression);
      }
    });
  });

  group('describeCron', () {
    test('reads the shapes the web app reads', () {
      expect(describeCron('*/15 * * * *'), 'Every 15 minutes');
      expect(describeCron('* * * * *'), 'Every minute');
      expect(describeCron('0 * * * *'), 'Every hour');
      expect(describeCron('15 * * * *'), 'Every hour at minute 15');
      expect(describeCron('0 9 * * *'), 'Every day at 09:00');
      expect(describeCron('30 8 * * 1-5'), 'Monday to Friday at 08:30');
      expect(describeCron('0 18 * * 0,6'), 'Every Sunday, Saturday at 18:00');
      expect(describeCron('0 0 1 * *'), 'Day 1 of every month at 00:00');
      expect(describeCron('0 9 * * mon-fri'), 'Monday to Friday at 09:00');
    });

    test('falls back to the expression itself', () {
      expect(describeCron('not a cron'), 'not a cron');
      expect(describeCron('0 9 31 2 *'), '0 9 31 2 *');
      expect(describeCron('5,10 9 * * *'), '5,10 9 * * *');
    });
  });
}
