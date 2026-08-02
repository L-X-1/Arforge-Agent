import 'package:arforge_acceptance/policy.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('rejects blank title', () {
    expect(() => normalizeTitle('   '), throwsArgumentError);
  });
}
